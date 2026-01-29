#!/usr/bin/env node

const path = require('path');
const express = require('express');
const multer = require('multer');
const mimeTypes = require('mime-types');
const archiver = require('archiver');

const config = require('./config');

const { translateDocumentBuffer } = require('./translateDocument');
const { ocrImageToText, translatePlainText } = require('./translateImage');

const app = express();

const MAX_FILES = config.MAX_FILES;
const IMAGE_BATCH_SIZE = config.IMAGE_BATCH_SIZE;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // translateDocument sync has practical limits; keep a sane cap server-side
    fileSize: 20 * 1024 * 1024,
    files: MAX_FILES
  }
});

const webRoot = path.join(__dirname, 'web');
app.use('/', express.static(webRoot));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

function getProjectId() {
  return config.GCP_PROJECT_ID;
}

function inferMimeTypeFromName(filename) {
  const inferred = mimeTypes.lookup(filename);
  return typeof inferred === 'string' ? inferred : '';
}

function safeBaseName(originalname) {
  if (!originalname) return 'file';
  return path.basename(originalname, path.extname(originalname));
}

function isImageMime(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
}

function isTruthy(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function parseSpacingLines(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(20, Math.floor(n)));
}

function blockSeparator(title) {
  return `===== ${title || 'file'} =====\n`;
}

function normalizeTextForTxt(value) {
  if (!value) return '';
  return String(value).replace(/\r\n/g, '\n');
}

function decodeXmlEntities(value) {
  if (!value) return '';
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function extractTextFromPptx(buffer) {
  // eslint-disable-next-line global-require
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => {
      const na = Number((/slide(\d+)\.xml/i.exec(a) || [])[1] || 0);
      const nb = Number((/slide(\d+)\.xml/i.exec(b) || [])[1] || 0);
      return na - nb;
    });

  if (slidePaths.length === 0) return '';

  let out = '';
  for (let i = 0; i < slidePaths.length; i += 1) {
    const xml = await zip.file(slidePaths[i]).async('string');
    const texts = [];
    const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/gi;
    let m;
    while ((m = re.exec(xml)) != null) {
      const t = decodeXmlEntities(m[1]).trim();
      if (t) texts.push(t);
    }
    if (texts.length > 0) {
      out += `--- Slide ${i + 1} ---\n`;
      out += `${texts.join(' ')}\n\n`;
    }
  }

  return normalizeTextForTxt(out).trim();
}

async function extractTextFromXlsx(buffer) {
  // eslint-disable-next-line global-require
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  let out = '';
  workbook.eachSheet((worksheet) => {
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = (row.values || [])
        .slice(1)
        .map((cell) => {
          if (cell == null) return '';
          if (typeof cell === 'object' && typeof cell.text === 'string') return cell.text;
          if (typeof cell === 'object' && 'result' in cell) return String(cell.result ?? '');
          return String(cell);
        })
        .map((v) => String(v).trim());

      if (cells.some((c) => c.length > 0)) rows.push(cells.join(','));
    });

    const normalized = rows.join('\n').trim();
    if (!normalized) return;
    out += `--- Sheet: ${worksheet.name || 'Sheet'} ---\n`;
    out += `${normalized}\n\n`;
  });

  return out.trim();
}

async function extractTextFromTranslatedDocument({ outputBuffer, outputMimeType, originalname }) {
  const mimeType = (outputMimeType || '').toLowerCase();

  if (mimeType === 'application/pdf') {
    // Lazy require to avoid startup cost when unused
    // eslint-disable-next-line global-require
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(outputBuffer);
    return normalizeTextForTxt(data && data.text ? data.text : '');
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    // eslint-disable-next-line global-require
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer: outputBuffer });
    return normalizeTextForTxt(result && result.value ? result.value : '');
  }

  if (
    mimeType ===
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    const text = await extractTextFromPptx(outputBuffer);
    return normalizeTextForTxt(text);
  }

  if (
    mimeType ===
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    const text = await extractTextFromXlsx(outputBuffer);
    return normalizeTextForTxt(text);
  }

  const name = originalname || 'document';
  return `[UNSUPPORTED] Não foi possível extrair texto para TXT a partir de ${name} (${mimeType || 'mime desconhecido'}).\n`;
}

async function asyncPool(poolLimit, items, iteratorFn) {
  const ret = [];
  const executing = new Set();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const p = Promise.resolve().then(() => iteratorFn(item, i));
    ret.push(p);

    executing.add(p);
    p.finally(() => executing.delete(p));

    if (executing.size >= poolLimit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(ret);
}

function getUploadedFiles(req) {
  // Supports:
  // - upload.single('file') -> req.file
  // - upload.array('files') -> req.files (array)
  // - upload.fields([...]) -> req.files.{files|file} arrays
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && Array.isArray(req.files.files)) return req.files.files;
  if (req.files && Array.isArray(req.files.file)) return req.files.file;
  return [];
}

function respondZip(res, zipName, builder) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    archive.on('error', (err) => {
      try {
        if (!res.headersSent) {
          res.status(500).send(err && err.message ? err.message : String(err));
        }
      } catch {
        // ignore
      }
      reject(err);
    });

    // 'close' fires when the underlying stream is closed
    archive.on('close', resolve);
    // 'end' fires when data has been drained
    archive.on('end', resolve);

    archive.pipe(res);

    (async () => {
      try {
        await builder(archive);
      } catch (err) {
        try {
          archive.append(`${err && err.message ? err.message : String(err)}\n`, {
            name: 'zip_error.txt'
          });
        } catch {
          // ignore
        }
      } finally {
        archive.finalize();
      }
    })();
  });
}

// Upload + translate, then returns the translated file as the response body.
// multipart/form-data fields:
// - file: document (required)
// - to: target language code (required)
// - from: source language code (optional)
// - mimeType: MIME type (optional; defaults to upload mimetype)
app.post('/translate-doc', upload.single('file'), async (req, res) => {
  try {
    const projectId = getProjectId();

    if (!projectId) {
      return res.status(400).json({
        error: 'Missing projectId. Set GCP_PROJECT_ID in .env.'
      });
    }

    const targetLanguageCode = req.body.to;
    if (!targetLanguageCode) {
      return res.status(400).json({ error: 'Missing required field: to' });
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'Missing file upload (field name: file)' });
    }

    const sourceLanguageCode = req.body.from || undefined;
    const location = config.GCP_LOCATION;
    const mimeType =
      req.body.mimeType ||
      req.file.mimetype ||
      inferMimeTypeFromName(req.file.originalname);

    const { outputBuffer, outputMimeType, detectedLanguageCode } = await translateDocumentBuffer({
      projectId,
      location,
      content: req.file.buffer,
      mimeType,
      sourceLanguageCode,
      targetLanguageCode
    });

    const base = req.file.originalname
      ? path.basename(req.file.originalname, path.extname(req.file.originalname))
      : 'document';

    const filename = `${base}_${targetLanguageCode}_translations${path.extname(req.file.originalname || '')}`;

    res.setHeader('Content-Type', outputMimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (detectedLanguageCode) res.setHeader('X-Detected-Language', detectedLanguageCode);

    return res.status(200).send(outputBuffer);
  } catch (err) {
    return res.status(500).json({
      error: err && err.message ? err.message : String(err)
    });
  }
});

// Upload + OCR + translateText, returns JSON with OCR and translated text.
// multipart/form-data fields:
// - file: image (required)
// - to: target language code (required)
// - from: source language code (optional)
app.post('/translate-image', upload.single('file'), async (req, res) => {
  try {
    const projectId = getProjectId();

    if (!projectId) {
      return res.status(400).json({
        error: 'Missing projectId. Set GCP_PROJECT_ID in .env.'
      });
    }

    const targetLanguageCode = req.body.to;
    if (!targetLanguageCode) {
      return res.status(400).json({ error: 'Missing required field: to' });
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'Missing file upload (field name: file)' });
    }

    const sourceLanguageCode = req.body.from || undefined;
    const location = config.GCP_LOCATION;

    const ocrText = await ocrImageToText({ content: req.file.buffer });
    if (!ocrText.trim()) {
      return res.status(422).json({ error: 'OCR did not detect any text in the image.' });
    }

    const { translatedText, detectedLanguageCode } = await translatePlainText({
      projectId,
      location,
      text: ocrText,
      sourceLanguageCode,
      targetLanguageCode
    });

    return res.status(200).json({
      detectedLanguageCode,
      ocrText,
      translatedText
    });
  } catch (err) {
    return res.status(500).json({
      error: err && err.message ? err.message : String(err)
    });
  }
});

// Unified endpoint for the web UI:
// - If document type: returns translated document as attachment
// - If image: returns translated text as a .txt attachment
app.post(
  '/api/translate',
  upload.fields([
    { name: 'files', maxCount: MAX_FILES },
    { name: 'file', maxCount: 1 }
  ]),
  async (req, res) => {
  try {
    const projectId = getProjectId();
    if (!projectId) {
      return res.status(400).send(
        'Missing projectId. Set GCP_PROJECT_ID in .env.'
      );
    }

    const targetLanguageCode = req.body.to;
    if (!targetLanguageCode) return res.status(400).send('Missing required field: to');

    const uploadedFiles = getUploadedFiles(req);
    if (uploadedFiles.length === 0) {
      return res.status(400).send('Missing file upload (field name: files)');
    }

    const sourceLanguageCode = req.body.from || undefined;
    const location = config.GCP_LOCATION;
    // spacing between each translated file (only used when combineImages produces a single TXT)
    const betweenTranslationsLines = parseSpacingLines(
      req.body.betweenTranslationsLines != null ? req.body.betweenTranslationsLines : req.body.spacingLines
    );

    const combineImages = isTruthy(req.body.combineImages);
    const combineAllToTxt = isTruthy(req.body.combineAllToTxt);

    if (uploadedFiles.length > 1) {
      if (combineAllToTxt) {
        const blocks = await asyncPool(IMAGE_BATCH_SIZE, uploadedFiles, async (f) => {
          const title = f.originalname || 'file';
          const uploadMime = f.mimetype || '';
          const fallbackMime = inferMimeTypeFromName(f.originalname);
          const effectiveMimeType =
            uploadMime && uploadMime !== 'application/octet-stream' ? uploadMime : fallbackMime;

          try {
            if (isImageMime(effectiveMimeType)) {
              const ocrText = await ocrImageToText({ content: f.buffer });
              if (!ocrText.trim()) {
                return { title, text: '[ERRO] OCR não detectou texto.' };
              }

              const { translatedText } = await translatePlainText({
                projectId,
                location,
                text: ocrText,
                sourceLanguageCode,
                targetLanguageCode
              });

              return { title, text: normalizeTextForTxt(translatedText || '') };
            }

            const mimeType = effectiveMimeType || req.body.mimeType;
            if (!mimeType) {
              return { title, text: '[ERRO] Não foi possível determinar o MIME type.' };
            }

            const { outputBuffer, outputMimeType } = await translateDocumentBuffer({
              projectId,
              location,
              content: f.buffer,
              mimeType,
              sourceLanguageCode,
              targetLanguageCode
            });

            const extracted = await extractTextFromTranslatedDocument({
              outputBuffer,
              outputMimeType,
              originalname: f.originalname
            });

            return { title, text: extracted };
          } catch (err) {
            return { title, text: `[ERRO] ${err && err.message ? err.message : String(err)}` };
          }
        });

        let combined = '';
        for (let i = 0; i < blocks.length; i += 1) {
          const b = blocks[i];
          combined += blockSeparator(b.title);
          combined += `${b.text || ''}\n`;
          if (i < blocks.length - 1 && betweenTranslationsLines > 0) {
            combined += '\n'.repeat(betweenTranslationsLines);
          }
        }

        const filename = `combined_${targetLanguageCode}_translations.txt`;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.status(200).send(combined);
      }

      // If user asked for a single output and ALL files are images, return a single TXT.
      if (combineImages) {
        const classified = uploadedFiles.map((f) => {
          const uploadMime = f.mimetype || '';
          const fallbackMime = inferMimeTypeFromName(f.originalname);
          const effectiveMimeType =
            uploadMime && uploadMime !== 'application/octet-stream' ? uploadMime : fallbackMime;
          return { f, effectiveMimeType };
        });

        const allImages = classified.every(({ effectiveMimeType }) => isImageMime(effectiveMimeType));

        if (allImages) {
          const results = await asyncPool(IMAGE_BATCH_SIZE, classified, async ({ f }) => {
            const title = f.originalname || 'image';

            try {
              const ocrText = await ocrImageToText({ content: f.buffer });
              if (!ocrText.trim()) {
                return { title, text: '[ERRO] OCR não detectou texto.' };
              }

              const { translatedText } = await translatePlainText({
                projectId,
                location,
                text: ocrText,
                sourceLanguageCode,
                targetLanguageCode
              });

              return { title, text: translatedText || '' };
            } catch (err) {
              return { title, text: `[ERRO] ${err && err.message ? err.message : String(err)}` };
            }
          });

          let combined = '';
          for (let i = 0; i < results.length; i += 1) {
            const r = results[i];
            combined += blockSeparator(r.title);
            combined += `${normalizeTextForTxt(r.text)}\n`;
            if (i < results.length - 1 && betweenTranslationsLines > 0) {
              combined += '\n'.repeat(betweenTranslationsLines);
            }
          }

          const filename = `images_${targetLanguageCode}_translations.txt`;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          return res.status(200).send(combined);
        }
      }

      await respondZip(res, 'translations.zip', async (archive) => {
        for (const f of uploadedFiles) {
          const uploadMime = f.mimetype || '';
          const fallbackMime = inferMimeTypeFromName(f.originalname);
          const effectiveMimeType =
            uploadMime && uploadMime !== 'application/octet-stream' ? uploadMime : fallbackMime;

          try {
            if (isImageMime(effectiveMimeType)) {
              const ocrText = await ocrImageToText({ content: f.buffer });
              if (!ocrText.trim()) {
                archive.append('OCR did not detect any text in the image.\n', {
                  name: `${safeBaseName(f.originalname)}_error.txt`
                });
                continue;
              }

              const { translatedText } = await translatePlainText({
                projectId,
                location,
                text: ocrText,
                sourceLanguageCode,
                targetLanguageCode
              });

              const name = `${safeBaseName(f.originalname)}_${targetLanguageCode}_translations.txt`;
              archive.append(translatedText || '', { name });
              continue;
            }

            const mimeType = effectiveMimeType || req.body.mimeType;
            if (!mimeType) {
              archive.append('Could not determine MIME type.\n', {
                name: `${safeBaseName(f.originalname)}_error.txt`
              });
              continue;
            }

            const { outputBuffer } = await translateDocumentBuffer({
              projectId,
              location,
              content: f.buffer,
              mimeType,
              sourceLanguageCode,
              targetLanguageCode
            });

            const name = `${safeBaseName(f.originalname)}_${targetLanguageCode}_translations${path.extname(
              f.originalname || ''
            )}`;
            archive.append(outputBuffer, { name });
          } catch (err) {
            archive.append(`${err && err.message ? err.message : String(err)}\n`, {
              name: `${safeBaseName(f.originalname)}_error.txt`
            });
          }
        }
      });

      return;
    }

    // Single file behavior (same as before)
    const f = uploadedFiles[0];
    const uploadMime = f.mimetype || '';
    const fallbackMime = inferMimeTypeFromName(f.originalname);
    const effectiveMimeType = uploadMime && uploadMime !== 'application/octet-stream' ? uploadMime : fallbackMime;

    if (isImageMime(effectiveMimeType)) {
      const ocrText = await ocrImageToText({ content: f.buffer });
      if (!ocrText.trim()) {
        return res.status(422).send('OCR did not detect any text in the image.');
      }

      const { translatedText, detectedLanguageCode } = await translatePlainText({
        projectId,
        location,
        text: ocrText,
        sourceLanguageCode,
        targetLanguageCode
      });

      const base = safeBaseName(f.originalname);
      const filename = `${base}_${targetLanguageCode}_translations.txt`;

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (detectedLanguageCode) res.setHeader('X-Detected-Language', detectedLanguageCode);
      return res.status(200).send(translatedText);
    }

    const mimeType = effectiveMimeType || req.body.mimeType;
    if (!mimeType) {
      return res.status(400).send('Could not determine MIME type. Please upload a supported file.');
    }

    const { outputBuffer, outputMimeType, detectedLanguageCode } = await translateDocumentBuffer({
      projectId,
      location,
      content: f.buffer,
      mimeType,
      sourceLanguageCode,
      targetLanguageCode
    });

    const base = safeBaseName(f.originalname) || 'document';
    const filename = `${base}_${targetLanguageCode}_translations${path.extname(f.originalname || '')}`;

    res.setHeader('Content-Type', outputMimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (detectedLanguageCode) res.setHeader('X-Detected-Language', detectedLanguageCode);
    return res.status(200).send(outputBuffer);
  } catch (err) {
    return res.status(500).send(err && err.message ? err.message : String(err));
  }
  }
);

// Friendly Multer error handling (e.g. Too many files)
app.use((err, _req, res, next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).send(`Too many files. Max allowed is ${MAX_FILES}.`);
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).send('File too large. Max allowed is 20MB per file.');
    }
    return res.status(400).send(err.message);
  }

  return next(err);
});

function startServer(port = config.PORT) {
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`DocTranslator server listening on http://localhost:${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };

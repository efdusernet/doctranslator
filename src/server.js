#!/usr/bin/env node

const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const multer = require('multer');
const mimeTypes = require('mime-types');
const { GoogleAuth } = require('google-auth-library');
const archiver = require('archiver');

const { translateDocumentBuffer } = require('./translateDocument');
const { ocrImageToText, translatePlainText } = require('./translateImage');

dotenv.config();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // translateDocument sync has practical limits; keep a sane cap server-side
    fileSize: 20 * 1024 * 1024,
    files: 10
  }
});

const webRoot = path.join(__dirname, 'web');
app.use('/', express.static(webRoot));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

async function getProjectId(req) {
  const fromRequest = req.body && req.body.projectId;
  const fromEnv =
    process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

  if (fromRequest) return fromRequest;
  if (fromEnv) return fromEnv;

  // Fallback: attempt to infer project from ADC (gcloud application-default login)
  // or from the quota project embedded in application_default_credentials.json.
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });

  try {
    const inferred = await auth.getProjectId();
    return inferred || '';
  } catch {
    return '';
  }
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
// - projectId: GCP project id (optional; defaults to env)
// - location: location id (optional; defaults to env/global)
// - mimeType: MIME type (optional; defaults to upload mimetype)
app.post('/translate-doc', upload.single('file'), async (req, res) => {
  try {
    const projectId = await getProjectId(req);

    if (!projectId) {
      return res.status(400).json({
        error: 'Missing projectId. Provide projectId field or set GCP_PROJECT_ID/GOOGLE_CLOUD_PROJECT.'
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
    const location = req.body.location || process.env.GCP_LOCATION || 'global';
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
// - projectId: GCP project id (optional; defaults to env)
// - location: location id (optional; defaults to env/global)
app.post('/translate-image', upload.single('file'), async (req, res) => {
  try {
    const projectId = await getProjectId(req);

    if (!projectId) {
      return res.status(400).json({
        error: 'Missing projectId. Provide projectId field or set GCP_PROJECT_ID/GOOGLE_CLOUD_PROJECT.'
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
    const location = req.body.location || process.env.GCP_LOCATION || 'global';

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
    { name: 'files', maxCount: 10 },
    { name: 'file', maxCount: 1 }
  ]),
  async (req, res) => {
  try {
    const projectId = await getProjectId(req);
    if (!projectId) {
      return res.status(400).send(
        'Missing projectId. Set GCP_PROJECT_ID (recommended) or configure ADC via: gcloud auth application-default login.'
      );
    }

    const targetLanguageCode = req.body.to;
    if (!targetLanguageCode) return res.status(400).send('Missing required field: to');

    const uploadedFiles = getUploadedFiles(req);
    if (uploadedFiles.length === 0) {
      return res.status(400).send('Missing file upload (field name: files)');
    }

    const sourceLanguageCode = req.body.from || undefined;
    const location = req.body.location || process.env.GCP_LOCATION || 'global';

    if (uploadedFiles.length > 1) {
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

function startServer(port = Number(process.env.PORT || 3003)) {
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

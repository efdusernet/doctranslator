const fs = require('fs/promises');
const path = require('path');
const mime = require('mime-types');
const crypto = require('crypto');

const config = require('./config');

const { PDFDocument } = require('pdf-lib');

const { TranslationServiceClient } = require('@google-cloud/translate').v3;
const { Storage } = require('@google-cloud/storage');

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

function normalizeBytesToBuffer(value) {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(value);
}

function inferMimeType(inputPath) {
  const inferred = mime.lookup(inputPath);
  return typeof inferred === 'string' ? inferred : undefined;
}

function defaultOutputPath(inputPath, targetLanguageCode, outputExt) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const ext = outputExt || path.extname(inputPath) || '';
  return path.join(dir, `${base}_${targetLanguageCode}_translations${ext}`);
}

function extForMimeType(mimeType) {
  // mime-types lib returns leading dot, e.g. '.pdf'
  const ext = mime.extension(mimeType);
  return ext ? `.${ext}` : undefined;
}

function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function stripLeadingSlash(value) {
  if (!value) return '';
  return String(value).replace(/^\/+/, '');
}

function makeGsUri(bucket, objectName) {
  return `gs://${bucket}/${stripLeadingSlash(objectName)}`;
}

function normalizeBucketName(bucketOrUri) {
  if (!bucketOrUri) return '';
  let s = String(bucketOrUri).trim();
  if (s.toLowerCase().startsWith('gs://')) s = s.slice(5);
  s = s.replace(/^\/+/, '');
  return s.split('/')[0];
}

async function translatePdfToDocxBuffer({
  projectId = config.GCP_PROJECT_ID,
  location = config.GCP_LOCATION,
  gcsBucket = config.GCS_TRANSLATION_BUCKET,
  content,
  sourceLanguageCode,
  targetLanguageCode
}) {
  if (!projectId) throw new Error('projectId é obrigatório');
  if (!targetLanguageCode) throw new Error('targetLanguageCode é obrigatório');
  const bucketName = normalizeBucketName(gcsBucket);
  if (!bucketName) {
    throw new Error(
      'Para PDF→DOCX é necessário configurar GCS_TRANSLATION_BUCKET no .env (ex: datatranslated ou gs://datatranslated).'
    );
  }
  if (!content || content.length === 0) throw new Error('content vazio');

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  const jobId = randomId();
  const inputObject = `doctranslator/input/${jobId}/input.pdf`;
  const outputPrefix = `doctranslator/output/${jobId}/`;

  await bucket.file(inputObject).save(content, {
    contentType: 'application/pdf',
    resumable: false
  });

  const client = new TranslationServiceClient();
  const parent = `projects/${projectId}/locations/${location}`;

  const request = {
    parent,
    targetLanguageCodes: [targetLanguageCode],
    inputConfigs: [
      {
        gcsSource: { inputUri: makeGsUri(bucketName, inputObject) },
        mimeType: 'application/pdf'
      }
    ],
    outputConfig: {
      gcsDestination: {
        outputUriPrefix: makeGsUri(bucketName, outputPrefix)
      }
    },
    formatConversions: {
      'application/pdf':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }
  };

  if (sourceLanguageCode) request.sourceLanguageCode = sourceLanguageCode;

  try {
    const [operation] = await client.batchTranslateDocument(request);
    await operation.promise();

    const [files] = await bucket.getFiles({ prefix: outputPrefix });
    const docx = files.find((f) => f.name.toLowerCase().endsWith('.docx'));
    if (!docx) {
      throw new Error(
        'BatchTranslateDocument concluiu, mas não foi encontrado arquivo .docx no output do GCS. '
          + 'Isso pode acontecer se o PDF não for nativo (escaneado) ou se a conversão tiver sido rejeitada.'
      );
    }

    const [downloaded] = await docx.download();
    return {
      outputBuffer: Buffer.from(downloaded),
      outputMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      detectedLanguageCode: ''
    };
  } finally {
    // Best-effort cleanup (ignore any errors)
    try {
      await bucket.file(inputObject).delete();
    } catch (_e) {
      // ignore
    }
    try {
      const [outFiles] = await bucket.getFiles({ prefix: outputPrefix });
      await Promise.all(outFiles.map((f) => f.delete().catch(() => null)));
    } catch (_e) {
      // ignore
    }
  }
}

async function splitPdfIntoChunks(inputBuffer, chunkSize) {
  const src = await PDFDocument.load(inputBuffer);
  const totalPages = src.getPageCount();
  const size = Math.max(1, Math.floor(chunkSize));

  const chunks = [];
  for (let start = 0; start < totalPages; start += size) {
    const end = Math.min(totalPages, start + size);
    const doc = await PDFDocument.create();
    const pageIndices = Array.from({ length: end - start }, (_v, i) => start + i);
    const copied = await doc.copyPages(src, pageIndices);
    copied.forEach((p) => doc.addPage(p));
    const bytes = await doc.save();
    chunks.push(Buffer.from(bytes));
  }

  return { totalPages, chunks };
}

async function mergePdfs(buffers) {
  const out = await PDFDocument.create();
  for (const b of buffers) {
    const doc = await PDFDocument.load(b);
    const indices = Array.from({ length: doc.getPageCount() }, (_v, i) => i);
    const pages = await out.copyPages(doc, indices);
    pages.forEach((p) => out.addPage(p));
  }
  const merged = await out.save();
  return Buffer.from(merged);
}

async function translatePdfWithSplittingIfNeeded({
  projectId,
  location,
  content,
  sourceLanguageCode,
  targetLanguageCode,
  isTranslateNativePdfOnly,
  enableShadowRemovalNativePdf,
  enableRotationCorrection,
  maxPagesPerRequest = 20
}) {
  const { totalPages, chunks } = await splitPdfIntoChunks(content, maxPagesPerRequest);

  if (totalPages <= maxPagesPerRequest) {
    return null;
  }

  const client = new TranslationServiceClient();
  const parent = `projects/${projectId}/locations/${location}`;

  const outputs = [];
  let detectedLanguageCode = '';

  for (const chunk of chunks) {
    const request = {
      parent,
      targetLanguageCode,
      documentInputConfig: {
        content: chunk,
        mimeType: 'application/pdf'
      }
    };

    if (sourceLanguageCode) request.sourceLanguageCode = sourceLanguageCode;
    if (typeof isTranslateNativePdfOnly === 'boolean') {
      request.isTranslateNativePdfOnly = isTranslateNativePdfOnly;
    }
    if (typeof enableShadowRemovalNativePdf === 'boolean') {
      request.enableShadowRemovalNativePdf = enableShadowRemovalNativePdf;
    }
    if (typeof enableRotationCorrection === 'boolean') {
      request.enableRotationCorrection = enableRotationCorrection;
    }

    const [response] = await client.translateDocument(request);
    const translation = response.documentTranslation;
    if (!translation || !translation.byteStreamOutputs || translation.byteStreamOutputs.length < 1) {
      throw new Error('Resposta inesperada: byteStreamOutputs vazio.');
    }

    detectedLanguageCode = detectedLanguageCode || translation.detectedLanguageCode || '';
    outputs.push(normalizeBytesToBuffer(translation.byteStreamOutputs[0]));
  }

  const merged = await mergePdfs(outputs);
  return {
    outputBuffer: merged,
    outputMimeType: 'application/pdf',
    detectedLanguageCode
  };
}

async function translateDocumentBuffer({
  projectId = config.GCP_PROJECT_ID,
  location = config.GCP_LOCATION,
  content,
  mimeType,
  sourceLanguageCode,
  targetLanguageCode,
  isTranslateNativePdfOnly,
  enableShadowRemovalNativePdf,
  enableRotationCorrection
}) {
  if (!projectId) throw new Error('projectId é obrigatório');
  if (!targetLanguageCode) throw new Error('targetLanguageCode é obrigatório');
  if (!mimeType) throw new Error('mimeType é obrigatório ao traduzir a partir de bytes');
  if (!content || content.length === 0) throw new Error('content vazio');

  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(
      `MIME type não suportado para translateDocument: ${mimeType}. ` +
        'Suportados: application/pdf, DOCX, PPTX, XLSX. '
    );
  }

  if (mimeType === 'application/pdf') {
    const splitResult = await translatePdfWithSplittingIfNeeded({
      projectId,
      location,
      content,
      sourceLanguageCode,
      targetLanguageCode,
      isTranslateNativePdfOnly,
      enableShadowRemovalNativePdf,
      enableRotationCorrection
    });
    if (splitResult) return splitResult;
  }

  const client = new TranslationServiceClient();
  const parent = `projects/${projectId}/locations/${location}`;

  const request = {
    parent,
    targetLanguageCode,
    documentInputConfig: {
      content,
      mimeType
    }
  };

  if (sourceLanguageCode) request.sourceLanguageCode = sourceLanguageCode;

  if (typeof isTranslateNativePdfOnly === 'boolean') {
    request.isTranslateNativePdfOnly = isTranslateNativePdfOnly;
  }
  if (typeof enableShadowRemovalNativePdf === 'boolean') {
    request.enableShadowRemovalNativePdf = enableShadowRemovalNativePdf;
  }
  if (typeof enableRotationCorrection === 'boolean') {
    request.enableRotationCorrection = enableRotationCorrection;
  }

  const [response] = await client.translateDocument(request);

  const translation = response.documentTranslation;
  if (!translation || !translation.byteStreamOutputs || translation.byteStreamOutputs.length < 1) {
    throw new Error('Resposta inesperada: byteStreamOutputs vazio.');
  }

  const outputMimeType = translation.mimeType || mimeType;
  const outputBuffer = normalizeBytesToBuffer(translation.byteStreamOutputs[0]);

  return {
    outputBuffer,
    outputMimeType,
    detectedLanguageCode: translation.detectedLanguageCode || ''
  };
}

async function translateLocalDocument({
  projectId = config.GCP_PROJECT_ID,
  location = config.GCP_LOCATION,
  inputPath,
  outputPath,
  mimeType,
  sourceLanguageCode,
  targetLanguageCode,
  isTranslateNativePdfOnly,
  enableShadowRemovalNativePdf,
  enableRotationCorrection
}) {
  if (!inputPath) throw new Error('inputPath é obrigatório');
  if (!targetLanguageCode) throw new Error('targetLanguageCode é obrigatório');

  const resolvedMimeType = mimeType || inferMimeType(inputPath);
  if (!resolvedMimeType) {
    throw new Error(
      'Não foi possível inferir o MIME type. Informe explicitamente via --mime (ex: application/pdf).'
    );
  }

  if (!SUPPORTED_MIME_TYPES.has(resolvedMimeType)) {
    throw new Error(
      `MIME type não suportado para translateDocument: ${resolvedMimeType}. ` +
        'Suportados: application/pdf, DOCX, PPTX, XLSX. '
    );
  }

  const content = await fs.readFile(inputPath);
  const { outputBuffer, outputMimeType, detectedLanguageCode } = await translateDocumentBuffer({
    projectId,
    location,
    content,
    mimeType: resolvedMimeType,
    sourceLanguageCode,
    targetLanguageCode,
    isTranslateNativePdfOnly,
    enableShadowRemovalNativePdf,
    enableRotationCorrection
  });

  const outExt = extForMimeType(outputMimeType);
  const finalOutputPath = outputPath || defaultOutputPath(inputPath, targetLanguageCode, outExt);
  await fs.writeFile(finalOutputPath, outputBuffer);

  return {
    outputPath: finalOutputPath,
    outputMimeType,
    detectedLanguageCode
  };
}

module.exports = {
  translateDocumentBuffer,
  translateLocalDocument,
  translatePdfToDocxBuffer
};

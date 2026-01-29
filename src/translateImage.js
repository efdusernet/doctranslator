const fs = require('fs/promises');
const path = require('path');

const config = require('./config');

const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { TranslationServiceClient } = require('@google-cloud/translate').v3;

function defaultOutputPath(inputPath, targetLanguageCode) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}_${targetLanguageCode}_translations.txt`);
}

async function ocrImageToText({ content }) {
  const vision = new ImageAnnotatorClient();
  const [result] = await vision.documentTextDetection({ image: { content } });

  const fullText = result.fullTextAnnotation && result.fullTextAnnotation.text;
  if (fullText && fullText.trim()) return fullText;

  // fallback
  const [fallback] = await vision.textDetection({ image: { content } });
  const annotations = fallback.textAnnotations || [];
  if (annotations[0] && annotations[0].description) return annotations[0].description;

  return '';
}

async function translatePlainText({
  projectId = config.GCP_PROJECT_ID,
  location = config.GCP_LOCATION,
  text,
  sourceLanguageCode,
  targetLanguageCode
}) {
  const client = new TranslationServiceClient();
  const parent = `projects/${projectId}/locations/${location}`;

  const request = {
    parent,
    contents: [text],
    targetLanguageCode,
    mimeType: 'text/plain'
  };

  if (sourceLanguageCode) request.sourceLanguageCode = sourceLanguageCode;

  const [response] = await client.translateText(request);
  const translation = response.translations && response.translations[0];

  return {
    translatedText: (translation && translation.translatedText) || '',
    detectedLanguageCode: (translation && translation.detectedLanguageCode) || ''
  };
}

async function translateLocalImage({
  projectId = config.GCP_PROJECT_ID,
  location = config.GCP_LOCATION,
  inputPath,
  outputPath,
  sourceLanguageCode,
  targetLanguageCode
}) {
  if (!inputPath) throw new Error('inputPath é obrigatório');
  if (!projectId) throw new Error('projectId é obrigatório');
  if (!targetLanguageCode) throw new Error('targetLanguageCode é obrigatório');

  const content = await fs.readFile(inputPath);
  const ocrText = await ocrImageToText({ content });

  if (!ocrText.trim()) {
    throw new Error('OCR não encontrou texto na imagem.');
  }

  const { translatedText, detectedLanguageCode } = await translatePlainText({
    projectId,
    location,
    text: ocrText,
    sourceLanguageCode,
    targetLanguageCode
  });

  const finalOutputPath = outputPath || defaultOutputPath(inputPath, targetLanguageCode);
  await fs.writeFile(finalOutputPath, translatedText, { encoding: 'utf8' });

  return {
    outputPath: finalOutputPath,
    detectedLanguageCode,
    ocrText,
    translatedText
  };
}

module.exports = {
  translateLocalImage,
  ocrImageToText,
  translatePlainText
};

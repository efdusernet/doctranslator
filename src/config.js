const dotenv = require('dotenv');

dotenv.config({ override: true });

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  PORT: toInt(process.env.PORT, 3003),
  MAX_FILES: toInt(process.env.MAX_FILES, 50),
  IMAGE_BATCH_SIZE: toInt(process.env.IMAGE_BATCH_SIZE, 10),
  GCP_PROJECT_ID:
    process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '',
  GCP_LOCATION: process.env.GCP_LOCATION || 'global',
  // Required when using batch translation / PDF->DOCX conversion
  GCS_TRANSLATION_BUCKET: process.env.GCS_TRANSLATION_BUCKET || ''
};

module.exports = config;

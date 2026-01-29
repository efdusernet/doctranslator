#!/usr/bin/env node

const path = require('path');
const { Command } = require('commander');
const { translateLocalDocument } = require('./translateDocument');
const { translateLocalImage } = require('./translateImage');

const config = require('./config');

const program = new Command();

program
  .name('doc-translator')
  .description('Traduz documentos via Google Cloud Translation API v3 (Advanced)')
  .version('0.1.0');

program
  .command('translate-doc')
  .description('Traduz um documento local (PDF/DOCX/PPTX/XLSX) de forma síncrona')
  .requiredOption('-i, --in <path>', 'Caminho do arquivo de entrada (ex: ./arquivo.pdf)')
  .requiredOption('-t, --to <lang>', 'Idioma de destino (ex: pt-BR)')
  .option('-f, --from <lang>', 'Idioma de origem (ex: en). Se omitido, detecta automaticamente quando possível')
  .option('--mime <mimeType>', 'MIME type do documento. Se omitido, tenta inferir pela extensão')
  .option('-o, --out <path>', 'Caminho do arquivo de saída')
  .option('--native-pdf-only', 'Para PDFs: traduz apenas páginas nativas (limites maiores)', false)
  .option('--shadow-removal', 'Para PDFs: remove shadow text em imagem de fundo (se aplicável)', false)
  .option('--rotation-correction', 'Para PDFs: habilita correção automática de rotação', false)
  .action(async (opts) => {
    const projectId = config.GCP_PROJECT_ID;

    if (!projectId) {
      console.error('Erro: defina GCP_PROJECT_ID no .env.');
      process.exitCode = 2;
      return;
    }

    const inputPath = path.resolve(process.cwd(), opts.in);
    const outputPath = opts.out ? path.resolve(process.cwd(), opts.out) : undefined;

    try {
      const result = await translateLocalDocument({
        projectId,
        location: config.GCP_LOCATION,
        inputPath,
        outputPath,
        mimeType: opts.mime,
        sourceLanguageCode: opts.from,
        targetLanguageCode: opts.to,
        isTranslateNativePdfOnly: Boolean(opts.nativePdfOnly),
        enableShadowRemovalNativePdf: Boolean(opts.shadowRemoval),
        enableRotationCorrection: Boolean(opts.rotationCorrection)
      });

      console.log(`OK: gerado ${result.outputPath}`);
      if (result.detectedLanguageCode) {
        console.log(`Detectado: ${result.detectedLanguageCode}`);
      }
      console.log(`MIME saída: ${result.outputMimeType}`);
    } catch (err) {
      console.error('Falha ao traduzir documento.');
      console.error(err && err.message ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command('translate-image')
  .description('Traduz uma imagem (PNG/JPG) via OCR (Vision) + translateText (gera TXT)')
  .requiredOption('-i, --in <path>', 'Caminho do arquivo de entrada (ex: ./scan.png)')
  .requiredOption('-t, --to <lang>', 'Idioma de destino (ex: pt-BR)')
  .option('-f, --from <lang>', 'Idioma de origem (ex: en). Se omitido, detecta automaticamente quando possível')
  .option('-o, --out <path>', 'Caminho do arquivo TXT de saída')
  .action(async (opts) => {
    const projectId = config.GCP_PROJECT_ID;

    if (!projectId) {
      console.error('Erro: defina GCP_PROJECT_ID no .env.');
      process.exitCode = 2;
      return;
    }

    const inputPath = path.resolve(process.cwd(), opts.in);
    const outputPath = opts.out ? path.resolve(process.cwd(), opts.out) : undefined;

    try {
      const result = await translateLocalImage({
        projectId,
        location: config.GCP_LOCATION,
        inputPath,
        outputPath,
        sourceLanguageCode: opts.from,
        targetLanguageCode: opts.to
      });

      console.log(`OK: gerado ${result.outputPath}`);
      if (result.detectedLanguageCode) {
        console.log(`Detectado: ${result.detectedLanguageCode}`);
      }
    } catch (err) {
      console.error('Falha ao traduzir imagem.');
      console.error(err && err.message ? err.message : err);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);

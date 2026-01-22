# DocTranslator (Node.js)

CLI para traduzir documentos (PDF/DOCX/PPTX/XLSX) usando **Google Cloud Translation API v3 (Advanced)** — método `translateDocument` (síncrono).

## 1) Pré-requisitos

- Node.js 18+ (você está ok)
- Projeto no Google Cloud com Billing ativo
- API habilitada: **Cloud Translation API**
- Para OCR de imagens (PNG/JPG): habilite também **Cloud Vision API**
- Service Account com permissão de uso da API

### Permissões (IAM)

- No projeto: `Cloud Translation API User` (ou papel equivalente que permita chamar a API)
- Se você for usar GCS no futuro (batch): permissões de Storage no bucket

## 2) Credenciais

Recomendado (local):

1. Crie uma Service Account e baixe o JSON da chave
2. Defina a env var:

PowerShell:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\\caminho\\sa-key.json"
```

Ou crie um `.env` (veja `.env.example`).

## 3) Instalação

```bash
npm install
```

## 4) Uso

### Traduzir um PDF

```bash
node src/cli.js translate-doc --in ./input.pdf --to pt-BR --project SEU_PROJECT_ID
```

### Traduzir DOCX/PPTX/XLSX

```bash
node src/cli.js translate-doc -i ./file.docx -t pt-BR --project SEU_PROJECT_ID
```

### Traduzir imagem (PNG/JPG) → TXT (OCR + tradução)

Isso faz OCR via Vision e traduz o texto via `translateText` (não preserva layout):

```bash
node src/cli.js translate-image -i "C:\\caminho\\scan.png" -t pt-BR --project SEU_PROJECT_ID
```

### Informar MIME manualmente (quando necessário)

```bash
node src/cli.js translate-doc -i ./arquivo -t pt-BR --project SEU_PROJECT_ID --mime application/pdf
```

## Observações importantes

- `translateDocument` (síncrono) tem limites de tamanho/páginas (ex.: PDF até ~20MB e limite de páginas conforme doc).
- Para **TXT/HTML** normalmente você usa `translateText` (não está implementado neste MVP).
- Se você precisar traduzir muitos arquivos / arquivos grandes, o caminho ideal é `batchTranslateDocument` com entradas/saídas em **Cloud Storage**.

## Servidor local (porta 3003)

Inicia um servidor HTTP local em `PORT` (padrão: **3003**):

```bash
npm run server
```

Abra no navegador:

- `http://localhost:3003/`

O Project ID é lido do servidor via `GCP_PROJECT_ID` (recomendado) ou inferido via ADC (gcloud).

Endpoints:

- `GET /health`
- `POST /api/translate` (multipart/form-data)
	- aceita PDF/DOCX/PPTX/XLSX e imagens PNG/JPG
	- campos: `file`, `to`, `from` (opcional), `projectId` (opcional)
	- resposta: attachment (arquivo traduzido ou TXT)
	- se enviar múltiplos arquivos (campo `files`), a resposta é um `translations.zip`
- `POST /translate-doc` (multipart/form-data)
	- campos: `file` (arquivo), `to` (idioma destino), `from` (opcional), `projectId` (opcional; senão usa env)
- `POST /translate-image` (multipart/form-data)
	- campos: `file` (PNG/JPG), `to`, `from` (opcional), `projectId` (opcional; senão usa env)

Exemplo (PowerShell + curl):

```powershell
curl -F "file=@.\input.pdf" -F "to=pt-BR" http://localhost:3003/translate-doc --output translated.pdf
```

Exemplo imagem:

```powershell
curl -F "file=@.\scan.png" -F "to=pt-BR" http://localhost:3003/translate-image
```

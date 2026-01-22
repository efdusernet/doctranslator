# DocTranslator (Node.js)

CLI para traduzir documentos (PDF/DOCX/PPTX/XLSX) usando **Google Cloud Translation API v3 (Advanced)** — método `translateDocument` (síncrono).

Também inclui uma **interface web** para subir 1 ou mais arquivos e baixar a tradução.

## Inicializar o servidor (porta 3003)

1) Garanta que `PORT=3003` (no `.env` ou via variável de ambiente).

2) Instale dependências (uma vez):

```bash
npm install
```

3) Inicie o servidor:

```bash
npm run server
```

4) Abra no navegador:

- `http://localhost:3003/`

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

Alternativa (local, sem JSON):

- `gcloud auth application-default login`

## 3) Instalação

```bash
npm install
```

## 4) Uso

## Uso via Web (recomendado)

1) Crie um `.env` na raiz do projeto (não comite):

```dotenv
GCP_PROJECT_ID=gen-lang-client-0374851836
GCP_LOCATION=global
PORT=3003
```

2) Inicie o servidor:

```bash
npm run server
```

3) Abra:

- `http://localhost:3003/`

4) Selecione 1 ou mais arquivos e clique em **Traduzir**

- 1 arquivo: baixa o arquivo traduzido (ou `.txt` para imagem)
- 2+ arquivos: baixa `translations.zip`

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
	- campos: `files` (1..N), `to`, `from` (opcional)
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

## Screenshots

Sugestão: coloque imagens em `docs/` e referencie aqui, por exemplo:

- `docs/ui.png` (tela principal)
- `docs/result-zip.png` (download do ZIP)

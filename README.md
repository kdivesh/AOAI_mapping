# Azure OpenAI Field Mapping – Fullstack App

This app lets you upload **XSD** files and a **CSV/XLSX** source file, calls **Azure OpenAI** to suggest mappings, and downloads **Excel** and/or **CBRE-styled HTML** outputs.

## Quick Start

### Backend
```bash
cd backend
npm i
# set env vars
export AZURE_OPENAI_ENDPOINT="https://<your-resource>.openai.azure.com/"
export AZURE_OPENAI_API_KEY="<your-key>"
export AZURE_OPENAI_DEPLOYMENT="gpt-4o"
export AZURE_OPENAI_API_VERSION="2024-10-21"
npm start
```

### Frontend
```bash
cd frontend
npm i
npm run dev
```
Open http://localhost:5173

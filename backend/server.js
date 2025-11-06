/** 
 * Azure OpenAI Mapping – Node/Express backend (single file)
 * API: POST /api/map (multipart/form-data)
 */
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const xlsx = require('xlsx');
const archiver = require('archiver');
const { parse: parseCsv } = require('csv-parse');
const iconv = require('iconv-lite');

const PORT = process.env.PORT || 8000;
const AZURE_ENDPOINT   = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_API_KEY    = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
const AZURE_API_VER    = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';

const app = express();
app.use(express.json());
app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
})

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function sniffDelimiter(firstLine) {
  const candidates = [',',';','\t','|'];
  let best=',', bestCount=-1;
  for (const c of candidates) {
    const cnt = (firstLine.match(new RegExp('\\' + c, 'g')) || []).length;
    if (cnt > bestCount) { best = c; bestCount = cnt; }
  }
  return best;
}

async function readSourceBufferToRows(buf, filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = xlsx.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return xlsx.utils.sheet_to_json(sheet, { defval: '' });
  }
  const head = iconv.decode(buf.slice(0, 10000), 'utf-8');
  const delim = sniffDelimiter((head.split(/\r?\n/)[0] || ','));
  return new Promise((resolve, reject) => {
    parseCsv(iconv.decode(buf, 'utf-8'), { delimiter: delim, columns: true, relax_column_count: true, trim: true }, (err, records) => {
      if (err) return reject(err);
      resolve(records.map(r => { for (const k in r) if (r[k] == null) r[k]=''; return r; }));
    });
  });
}

function parseXsdPaths(name, xmlString) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const j = parser.parse(xmlString);
  let schema = j['xs:schema'] || j.schema || Object.values(j).find(v => v && typeof v === 'object' && v['xs:element']);
  if (!schema) return [];
  const complexTypes = {};
  const cts = schema['xs:complexType'] ? (Array.isArray(schema['xs:complexType'])? schema['xs:complexType'] : [schema['xs:complexType']]) : [];
  for (const ct of cts) if (ct.name) complexTypes[ct.name] = ct;
  const elements = schema['xs:element'] ? (Array.isArray(schema['xs:element']) ? schema['xs:element'] : [schema['xs:element']]) : [];
  const rows = [];
  function childElements(node) {
    if (!node) return [];
    const seqs = [];
    for (const tag of ['xs:sequence','xs:choice','xs:all']) {
      const n = node[tag]; if (!n) continue;
      const arr = Array.isArray(n) ? n : [n];
      for (const s of arr) {
        const kids = s && s['xs:element'];
        if (kids) seqs.push(...(Array.isArray(kids)? kids : [kids]));
      }
    }
    return seqs;
  }
  function walk(el, prefix) {
    const elName = el.name || (el.ref ? String(el.ref).split(':').pop() : '(anon)');
    const pathStr = prefix ? `${prefix}/${elName}` : elName;
    const mino = el.minOccurs ?? '1';
    const maxo = el.maxOccurs ?? '1';
    const tname = el.type ? String(el.type).split(':').pop() : null;
    let ct = null;
    if (tname && complexTypes[tname]) ct = complexTypes[tname];
    else if (el['xs:complexType']) ct = el['xs:complexType'];
    const kids = childElements(ct);
    if (!ct || !kids.length) {
      rows.push({ schema: name, path: pathStr, name: elName, type: tname || (ct ? 'complexType' : 'simpleType'), minOccurs: String(mino), maxOccurs: String(maxo) });
      return;
    }
    for (const kid of kids) walk(kid, pathStr);
  }
  for (const gel of elements) walk(gel, '');
  const seen = new Set();
  return rows.filter(r => { const key = r.schema + '|' + r.path; if (seen.has(key)) return false; seen.add(key); return true; });
}

async function aoaiMapBatch(sourceCols, targetRows, sampleMap) {
  if (!AZURE_ENDPOINT || !AZURE_API_KEY || !AZURE_DEPLOYMENT) throw new Error('Azure OpenAI env vars missing');
  const url = `${AZURE_ENDPOINT}openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VER}`;
  const system = [
    'You map source dataset fields to XSD target element paths.',
    'Return strict JSON only. Score 0..1 (float). Prefer exact semantics.',
    'If unsure, pick the closest path but lower the score and add a short rationale.'
  ].join('\\n');
  const payload = {
    instruction: 'Map each source field to the most appropriate target path. Return an array of {source, target_path, score, rationale}.',
    source_fields: sourceCols,
    sample_values: sampleMap,
    target_dictionary: targetRows.slice(0, 3000).map(r => ({ path: r.path, type: r.type || '', occurs: `${r.minOccurs || ''}..${r.maxOccurs || ''}`, schema: r.schema || '' }))
  };
  const data = {
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: JSON.stringify(payload) }
    ],
    max_tokens: 4000,
    temperature: 0.2
  };
  console.log('Request payload:', JSON.stringify(data, null, 2));
  const resp = await axios.post(url, data, { 
    headers: { 
      'api-key': AZURE_API_KEY, 
      'Content-Type': 'application/json'
    }, 
    timeout: 120000 
  });
  const body = resp.data;
  console.log('Azure OpenAI Response:', JSON.stringify(body, null, 2));
  const text = body.choices[0].message.content;
  console.log('Content to parse:', text);
  let obj;
  try {
    obj = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    console.error('JSON Parse Error:', e.message);
    console.error('Received text:', text);
    throw new Error('AOAI returned non-JSON');
  }
  const mappings = Array.isArray(obj) ? obj : (obj.mappings || []);
  return mappings.map(m => ({ SourceField: m.source || '', SuggestedTargetPath: m.target_path || '', MatchScore: Number(m.score) || 0, Rationale: m.rationale || '' }));
}

function colorForScore(v) {
  const clamp = x => Math.max(0, Math.min(1, x || 0));
  v = clamp(v);
  function hexToRgb(h){ const s=h.replace('#',''); return [parseInt(s.slice(0,2),16),parseInt(s.slice(2,4),16),parseInt(s.slice(4,6),16)]; }
  function rgbToHex(r,g,b){ return '#' + [r,g,b].map(n=>n.toString(16).padStart(2,'0')).join(''); }
  function blend(a,b,t){ return [Math.round(a[0]+(b[0]-a[0])*t),Math.round(a[1]+(b[1]-a[1])*t),Math.round(a[2]+(b[2]-a[2])*t)]; }
  const RED = hexToRgb('#F8696B'), YEL = hexToRgb('#FFEB84'), GRN = hexToRgb('#63BE7B');
  const rgb = v <= 0.5 ? blend(RED, YEL, v/0.5) : blend(YEL, GRN, (v-0.5)/0.5);
  return rgbToHex(...rgb);
}

function buildExcelBuffer(dfBySource, dfByScore, targetDict, srcPreview) {
  function aoaFromDf(df) { if (!df.length) return [[]]; const headers = Object.keys(df[0]); return [headers, ...df.map(r => headers.map(h => r[h]))]; }
  const wb = xlsx.utils.book_new();
  function addSheet(name, df, styleMatch=true) {
    const aoa = aoaFromDf(df);
    const ws = xlsx.utils.aoa_to_sheet(aoa);
    const headers = aoa[0] || [];
    ws['!cols'] = headers.map(h => ({ wch: Math.max(12, Math.min(60, String(h).length + 2)) }));
    const msIdx = headers.indexOf('MatchScore');
    if (styleMatch && msIdx >= 0) {
      for (let r = 1; r < aoa.length; r++) {
        const cellRef = xlsx.utils.encode_cell({ c: msIdx, r });
        const raw = df[r-1]['MatchScore'];
        const v = typeof raw === 'number' ? raw : (String(raw).endsWith('%') ? parseFloat(String(raw))/100 : parseFloat(String(raw)) || 0);
        const pctText = isFinite(v) ? `${(v*100).toFixed(1)}%` : '';
        ws[cellRef] = { t: 's', v: pctText };
        let bg = '#FFFFFF';
        if (isFinite(v)) bg = v < 0.60 ? '#FCE4E4' : colorForScore(v);
        ws[cellRef].s = { fill: { patternType: 'solid', fgColor: { rgb: bg.replace('#','').toUpperCase() } }, alignment: { horizontal: 'center' } };
      }
    }
    xlsx.utils.book_append_sheet(wb, ws, name.slice(0,31));
  }
  addSheet('Suggested Mapping (By Source)', dfBySource);
  addSheet('Suggested Mapping (By Score)', dfByScore);
  addSheet('Target Dictionary', targetDict, false);
  addSheet('Source Preview (first 50)', srcPreview, false);
  return xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

function dfToHtmlDoc(title, rows) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  let thead = '<tr>' + headers.map(h => `<th>${esc(h)}</th>`).join('') + '</tr>';
  function msNum(x){ if (typeof x === 'number') return x; const s=String(x); return s.endsWith('%')? parseFloat(s)/100 : parseFloat(s); }
  let tbody = rows.map(row => {
    return '<tr>' + headers.map(h => {
      if (h === 'MatchScore') {
        const v = msNum(row[h]);
        const txt = isFinite(v) ? `${(v*100).toFixed(1)}%` : '';
        const low = isFinite(v) && v < 0.60;
        const bg = low ? '#FCE4E4' : (isFinite(v) ? colorForScore(v) : 'transparent');
        const cls = 'ms-cell' + (low ? ' ms-low' : '');
        return `<td class="${cls}" style="background:${bg};">${esc(txt)}</td>`;
      }
      return `<td>${esc(row[h])}</td>`;
    }).join('') + '</tr>';
  }).join('');
  const BRAND_CSS = `
  <style>
  :root{ --cbre-green:#006A4D; --cbre-green-600:#0B6049; --cbre-green-50:#E6F2EE; --cbre-border:#D6E3DE; --text:#102A2C; --muted:#415B5E; --low-red:#FCE4E4; }
  body{font-family:"Segoe UI", Arial, Helvetica, sans-serif; line-height:1.45; color:var(--text); background:#fff; padding:20px;}
  .header{display:flex; align-items:center; gap:12px; margin-bottom:14px;}
  .logo{width:18px; height:18px; background:var(--cbre-green); border-radius:3px; display:inline-block;}
  h1{font-size:20px; margin:0; color:var(--cbre-green);} h2{font-size:16px; color:var(--muted); margin:6px 0 18px;}
  .table-wrap{border:1px solid var(--cbre-border); border-radius:8px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,0.04);} table{border-collapse:collapse; width:100%;}
  thead th{background:var(--cbre-green-50); color:#0E2D25; text-align:left; padding:10px; border-bottom:1px solid var(--cbre-border); font-weight:600; font-size:13px;}
  tbody td{padding:8px 10px; border-bottom:1px solid #eef3f2; font-size:13px; vertical-align:top;} tbody tr:nth-child(even) td{background:#FAFCFB;}
  .ms-cell{white-space:nowrap; font-variant-numeric:tabular-nums;} .ms-low{background:var(--low-red) !important;}
  .footer{margin-top:16px; font-size:12px; color:#6a7f81;} small.mono{font-family:Consolas, "Courier New", monospace;}
  </style>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>${esc(title)}</title>${BRAND_CSS}</head><body>
  <div class="header"><span class="logo"></span><h1>Field Mapping</h1></div>
  <h2>${esc(title)}</h2>
  <div class="table-wrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>
  <div class="footer">Generated by Azure OpenAI assisted mapper</div>
  </body></html>`;
}

app.post('/api/map', upload.fields([{ name: 'xsd_files' }, { name: 'source_file', maxCount: 1 }]), async (req, res) => {
  try {
    const outputFormat = (req.body.output_format || 'both').toLowerCase();
    const projectName  = (req.body.project_name || 'mapping-output').trim() || 'mapping-output';
    if (!['xlsx','html','both'].includes(outputFormat)) return res.status(400).send('output_format must be xlsx|html|both');

    const xsdFiles = (req.files['xsd_files'] || []);
    const srcFile  = (req.files['source_file'] && req.files['source_file'][0]);
    if (!xsdFiles.length) return res.status(400).send('At least one xsd_files required');
    if (!srcFile) return res.status(400).send('source_file required');

    const sourceRows = await readSourceBufferToRows(srcFile.buffer, srcFile.originalname);
    const sourceFields = sourceRows.length ? Object.keys(sourceRows[0]) : [];

    let targetDict = [];
    for (const f of xsdFiles) targetDict = targetDict.concat(parseXsdPaths(f.originalname, f.buffer.toString('utf-8')));
    const seen = new Set();
    targetDict = targetDict.filter(r => { const k = r.schema + '|' + r.path; if (seen.has(k)) return false; seen.add(k); return true; });

    const samples = {}; for (const col of sourceFields) samples[col] = [...new Set(sourceRows.map(r => (r[col] ?? '').toString()))].filter(Boolean).slice(0,3);

    let results = [];
    for (let i=0; i<sourceFields.length; i+=60) {
      const batch = sourceFields.slice(i, i+60);
      const subset = {}; batch.forEach(k => subset[k] = samples[k]);
      const mapped = await aoaiMapBatch(batch, targetDict, subset);
      results = results.concat(mapped);
    }
    const have = new Set(results.map(r => r.SourceField));
    for (const c of sourceFields) if (!have.has(c)) results.push({ SourceField: c, SuggestedTargetPath: '', MatchScore: 0.0, Rationale: '' });

    const extraByPath = new Map(targetDict.map(r => [r.path, r]));
    const bySource = results.map((r, idx) => {
      const extra = extraByPath.get(r.SuggestedTargetPath) || {};
      return {
        SourceOrder: idx + 1,
        SourceField: r.SourceField,
        SuggestedTargetPath: r.SuggestedTargetPath,
        TargetSchema: extra.schema || '',
        TargetType: extra.type || '',
        Occurs: `${extra.minOccurs || ''}..${extra.maxOccurs || ''}`,
        MatchScore: r.MatchScore,
        SampleValue: samples[r.SourceField]?.[0] || '',
        Rationale: r.Rationale || ''
      };
    });
    const byScore = [...bySource].sort((a,b) => (b.MatchScore||0) - (a.MatchScore||0));

    if (outputFormat === 'xlsx') {
      const srcPreview = sourceRows.slice(0, 50);
      const xbuf = buildExcelBuffer(bySource, byScore, targetDict, srcPreview);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${projectName}.xlsx"`);
      return res.end(xbuf);
    }

    const htmlFiles = [
      { name: 'Suggested_Mapping_By_Source.html', data: Buffer.from(dfToHtmlDoc('Suggested Mapping (By Source)', bySource)) },
      { name: 'Suggested_Mapping_By_Score.html',  data: Buffer.from(dfToHtmlDoc('Suggested Mapping (By Score)', byScore)) },
      { name: 'Target_Dictionary.html',           data: Buffer.from(dfToHtmlDoc('Target Dictionary', targetDict)) },
      { name: 'Source_Preview_first_50.html',     data: Buffer.from(dfToHtmlDoc('Source Preview (first 50)', sourceRows.slice(0,50))) },
    ];

    if (outputFormat === 'html') {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${projectName}_html.zip"`);
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', err => { throw err; });
      archive.pipe(res);
      for (const f of htmlFiles) archive.append(f.data, { name: f.name });
      return archive.finalize();
    }

    const srcPreview = sourceRows.slice(0, 50);
    const xbuf = buildExcelBuffer(bySource, byScore, targetDict, srcPreview);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${projectName}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);
    archive.append(xbuf, { name: `${projectName}.xlsx` });
    for (const f of htmlFiles) archive.append(f.data, { name: f.name });
    return archive.finalize();
  } catch (err) {
    console.error(err);
    return res.status(500).send(typeof err?.message === 'string' ? err.message : 'Internal error');
  }
});

app.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));

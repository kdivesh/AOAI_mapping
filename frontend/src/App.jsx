
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Upload, FileSpreadsheet, FileCode2, Trash2, Download, Settings2, Loader2 } from "lucide-react";

const XSD_ACCEPT = [".xsd"];
const SRC_ACCEPT = [".csv", ".xlsx", ".xls"];
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

function prettyBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B","KB","MB","GB","TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function extractFilenameFromDisposition(dispo, fallback = "mapping-output") {
  if (!dispo) return `${fallback}.zip`;
  const m = /filename\\*=UTF-8''([^;\\n]+)/i.exec(dispo) || /filename=\"?([^\";\\n]+)\"?/i.exec(dispo);
  const raw = m?.[1];
  if (!raw) return `${fallback}.zip`;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

export default function App() {
  const [xsdFiles, setXsdFiles] = useState([]);
  const [sourceFile, setSourceFile] = useState(null);
  const [outputFormat, setOutputFormat] = useState("both");
  const [projectName, setProjectName] = useState("");
  const [error, setError] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lastDownloadName, setLastDownloadName] = useState("");

  const inputXsdRef = useRef(null);
  const inputSrcRef = useRef(null);

  const totalSize = useMemo(() => {
    const xsdSum = xsdFiles.reduce((a, f) => a + f.size, 0);
    return xsdSum + (sourceFile?.size || 0);
  }, [xsdFiles, sourceFile]);

  const onPickXsd = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    const filtered = files.filter(f => XSD_ACCEPT.some(ext => f.name.toLowerCase().endsWith(ext)));
    setXsdFiles(prev => {
      const all = [...prev, ...filtered];
      const seen = new Set();
      return all.filter(f => {
        const key = `${f.name}__${f.size}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    });
    e.target.value = "";
  }, []);

  const onPickSource = useCallback((e) => {
    const file = (e.target.files && e.target.files[0]) || null;
    if (file && !SRC_ACCEPT.some(ext => file.name.toLowerCase().endsWith(ext))) {
      setError("Source must be CSV/XLS/XLSX."); return;
    }
    setSourceFile(file);
    e.target.value = "";
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    const files = Array.from(e.dataTransfer.files || []);
    const xsds = files.filter(f => XSD_ACCEPT.some(ext => f.name.toLowerCase().endsWith(ext)));
    const src = files.find(f => SRC_ACCEPT.some(ext => f.name.toLowerCase().endsWith(ext)));
    if (xsds.length) {
      setXsdFiles(prev => {
        const all = [...prev, ...xsds];
        const seen = new Set();
        return all.filter(f => {
          const key = `${f.name}__${f.size}`;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
      });
    }
    if (src) setSourceFile(src);
  }, []);

  const onDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); }, []);

  const removeXsd = useCallback((idx) => setXsdFiles(prev => prev.filter((_, i) => i !== idx)), []);

  const canSubmit = useMemo(() => xsdFiles.length > 0 && !!sourceFile && !isUploading, [xsdFiles, sourceFile, isUploading]);

  async function submitForm() {
    setError(null);
    if (!canSubmit) return;

    const formData = new FormData();
    xsdFiles.forEach(f => formData.append("xsd_files", f, f.name));
    if (sourceFile) formData.append("source_file", sourceFile, sourceFile.name);
    formData.append("output_format", outputFormat);
    if (projectName.trim()) formData.append("project_name", projectName.trim());

    setIsUploading(true); setProgress(0);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}/api/map`, true);
      xhr.responseType = "blob";
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) setProgress(Math.round((evt.loaded / evt.total) * 100));
      };
      const promise = new Promise((resolve, reject) => {
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            if (xhr.status >= 200 && xhr.status < 300) {
              const dispo = xhr.getResponseHeader("Content-Disposition");
              const filename = extractFilenameFromDisposition(dispo, projectName || "mapping-output");
              const blob = xhr.response;
              const link = document.createElement("a");
              const url = URL.createObjectURL(blob);
              link.href = url; link.download = filename; document.body.appendChild(link); link.click();
              link.remove(); URL.revokeObjectURL(url); setLastDownloadName(filename);
              resolve();
            } else {
              reject(new Error("Upload failed: " + xhr.status));
            }
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
      });
      xhr.send(formData);
      await promise;
    } catch (e) {
      setError(e?.message || "Upload failed");
    } finally {
      setIsUploading(false); setProgress(0);
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="mb-6 flex items-center gap-3">
        <div className="w-6 h-6 rounded bg-emerald-700" />
        <h1 className="text-2xl font-semibold text-emerald-800">Azure OpenAI – Field Mapping Uploader</h1>
      </div>

      <div onDrop={onDrop} onDragOver={onDragOver} className="border-2 border-dashed border-emerald-300 rounded-2xl p-6 sm:p-8 bg-emerald-50/40">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-emerald-800">
              <Upload className="w-5 h-5" /><span className="font-medium">Drop files here</span>
            </div>
            <p className="text-sm text-emerald-900/70">Add one or more <span className="font-semibold">.xsd</span> files and a single source (<span className="font-semibold">.csv / .xlsx / .xls</span>).</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => document.getElementById('xsd-input').click()} className="inline-flex items-center gap-2 rounded-xl bg-white border border-emerald-200 px-3 py-2 text-sm hover:bg-emerald-50">
              <FileCode2 className="w-4 h-4" />Add XSD(s)
            </button>
            <button type="button" onClick={() => document.getElementById('src-input').click()} className="inline-flex items-center gap-2 rounded-xl bg-white border border-emerald-200 px-3 py-2 text-sm hover:bg-emerald-50">
              <FileSpreadsheet className="w-4 h-4" />Add Source
            </button>
          </div>
        </div>
        <input id="xsd-input" type="file" accept={XSD_ACCEPT.join(',')} multiple className="hidden" onChange={onPickXsd} />
        <input id="src-input" type="file" accept={SRC_ACCEPT.join(',')} className="hidden" onChange={onPickSource} />
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-2xl border border-emerald-200 bg-white p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-emerald-900">XSD Files</h2>
            {xsdFiles.length > 0 && <button onClick={() => setXsdFiles([])} className="text-xs text-emerald-700 hover:underline">Clear</button>}
          </div>
          {xsdFiles.length === 0 ? <p className="text-sm text-emerald-900/70">No XSDs selected.</p> : (
            <ul className="divide-y divide-emerald-100">
              {xsdFiles.map((f, idx) => (
                <li key={`${f.name}-${f.size}-${idx}`} className="py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{f.name}</p>
                    <p className="text-xs text-emerald-900/70">{prettyBytes(f.size)}</p>
                  </div>
                  <button onClick={() => removeXsd(idx)} className="p-1.5 rounded hover:bg-emerald-50"><Trash2 className="w-4 h-4 text-emerald-800" /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-white p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-emerald-900">Source File</h2>
            {sourceFile && <button onClick={() => setSourceFile(null)} className="text-xs text-emerald-700 hover:underline">Remove</button>}
          </div>
          {!sourceFile ? <p className="text-sm text-emerald-900/70">No source selected.</p> : (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{sourceFile.name}</p>
                <p className="text-xs text-emerald-900/70">{prettyBytes(sourceFile.size)}</p>
              </div>
              <Trash2 className="w-4 h-4 text-emerald-800" />
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-emerald-200 bg-white p-4">
        <div className="flex items-center gap-2 mb-3">
          <Settings2 className="w-4 h-4 text-emerald-800" />
          <h2 className="text-sm font-semibold text-emerald-900">Options</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-emerald-900/80">Output Format</label>
            <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)} className="rounded-xl border border-emerald-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300 bg-white">
              <option value="both">Excel + HTML (zip)</option>
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="html">HTML (per sheet)</option>
            </select>
          </div>
          <div className="flex flex-col gap-1 md:col-span-2">
            <label className="text-xs text-emerald-900/80">Project / Output Name (optional)</label>
            <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="e.g., GWS_Invoice_Mapping" className="rounded-xl border border-emerald-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300 bg-white" />
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <button onClick={submitForm} disabled={!canSubmit} className={`inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium text-white ${canSubmit ? "bg-emerald-700 hover:bg-emerald-800" : "bg-emerald-300 cursor-not-allowed"}`}>
          {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {isUploading ? "Uploading…" : "Generate Mapping"}
        </button>
        <button onClick={() => { setXsdFiles([]); setSourceFile(null); setProgress(0); setError(null); setLastDownloadName(""); }} className="rounded-2xl px-4 py-2 text-sm border border-emerald-200 bg-white hover:bg-emerald-50">Reset</button>
        <div className="ml-auto text-sm text-emerald-900/70 flex items-center gap-2">
          <span>Total size:</span><span className="font-medium">{prettyBytes(totalSize)}</span>
        </div>
      </div>

      {isUploading && (
        <div className="mt-4">
          <div className="w-full bg-emerald-100 rounded-full h-2 overflow-hidden">
            <div className="h-2 bg-emerald-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="text-xs text-emerald-900/70 mt-1">Uploading… {progress}%</div>
        </div>
      )}

      {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-red-800 text-sm">{error}</div>}

      {lastDownloadName && !isUploading && (
        <div className="mt-4 inline-flex items-center gap-2 text-emerald-800 text-sm">
          <Download className="w-4 h-4" /><span>Downloaded: <span className="font-medium">{lastDownloadName}</span></span>
        </div>
      )}

      <div className="mt-8 text-xs text-emerald-900/60">
        <p><span className="font-semibold">API</span>: POST <code className="px-1 py-0.5 bg-emerald-50 rounded">/api/map</code>, form-data: <code>xsd_files[]</code>, <code>source_file</code>, <code>output_format</code>, <code>project_name</code>.</p>
        <p>Set <code>VITE_API_BASE</code> (e.g., http://localhost:8000) in <code>frontend/.env</code> if needed.</p>
      </div>
    </div>
  );
}

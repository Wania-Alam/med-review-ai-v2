import { useEffect, useState } from 'react';
import { api } from './api';

export default function PatientView({ id, mine, prompts, doctors, reloadPrompts, toast }) {
  const [data, setData] = useState(null);
  const [sel, setSel] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState(null); // { text, ids } - exists only in the browser until accepted
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState('Lab report');
  const [file, setFile] = useState(null);
  const [consultDoc, setConsultDoc] = useState('');

  const load = async () => {
    const d = await api(`/api/patients/${id}`);
    setData(d); setSel(d.reports.map((r) => r.id));
  };
  useEffect(() => { setDraft(null); setData(null); load().catch((e) => toast(e.message)); }, [id]);

  const upload = async () => {
    if (!file) return toast('Choose a file first');
    const fd = new FormData(); fd.append('file', file); fd.append('type', type);
    try { await api(`/api/patients/${id}/reports`, { method: 'POST', body: fd }); toast('Uploaded'); setFile(null); load(); }
    catch (e) { toast(e.message); }
  };
  const toggle = (rid) => setSel((s) => (s.includes(rid) ? s.filter((x) => x !== rid) : [...s, rid]));

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/patients/${id}/ai-summary`, { method: 'POST', body: { report_ids: sel, prompt } });
      setDraft({ text: r.draft, ids: [...sel] });
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const accept = async () => {
    try {
      await api(`/api/patients/${id}/summaries`, { method: 'POST', body: { text: draft.text, report_ids: draft.ids } });
      setDraft(null); toast('Summary verified and saved as PDF'); load();
    } catch (e) { toast(e.message); }
  };
  const reject = () => { setDraft(null); toast('Draft rejected - nothing was saved'); };

  const savePrompt = async () => {
    if (!prompt.trim()) return;
    const title = window.prompt('Name for this prompt'); if (!title) return;
    await api('/api/prompts', { method: 'POST', body: { title, text: prompt } });
    reloadPrompts(); toast('Prompt saved');
  };
  const share = async () => {
    const did = consultDoc || doctors[0]?.id; if (!did) return;
    await api(`/api/patients/${id}/consult`, { method: 'POST', body: { doctor_id: did } });
    toast('Shared with doctor');
  };

  if (!data) return <div className="card mut">Loading…</div>;
  const { patient: p, reports, summaries } = data;

  return (
    <>
      <div className="card">
        <div className="row spread">
          <div>
            <h3>{p.name}</h3>
            <div className="mut">{p.age}y · {p.gender} · History: {p.history || '-'}</div>
          </div>
          {mine && (
            <div className="row">
              <select aria-label="Doctor" value={consultDoc} onChange={(e) => setConsultDoc(e.target.value)}>
                {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <button className="ghost" onClick={share}>Share for consult</button>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Reports &amp; scans</h3>
        <div className="row" style={{ marginBottom: 10 }}>
          <select aria-label="Report type" style={{ width: 130 }} value={type} onChange={(e) => setType(e.target.value)}>
            {['Lab report', 'X-ray', 'CT scan', 'MRI', 'Other'].map((t) => <option key={t}>{t}</option>)}
          </select>
          <input type="file" style={{ width: 'auto' }} accept=".pdf,.txt,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files[0])} />
          <button onClick={upload}>Upload</button>
        </div>
        {reports.map((r) => (
          <label className="rep" key={r.id}>
            <input type="checkbox" checked={sel.includes(r.id)} onChange={() => toggle(r.id)} />
            <span><b>{r.type}</b> - <a href={`/api/reports/${r.id}/file`} target="_blank" rel="noreferrer">{r.filename}</a> <span className="mut">{new Date(r.created_at).toLocaleString()}</span></span>
          </label>
        ))}
        {!reports.length && <p className="mut">No reports yet.</p>}
      </div>

      <div className="card">
        <h3>AI summary</h3>
        <div className="mut">Quick prompts:</div>
        <div className="row" style={{ margin: '6px 0' }}>
          {prompts.map((x) => <button key={x.id} className="chip" onClick={() => setPrompt(x.text)}>{x.title}</button>)}
        </div>
        <textarea rows={2} placeholder="Instruction for the AI (or pick a quick prompt)" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={generate} disabled={busy}>{busy ? <><span className="spin" /> Analysing…</> : 'Generate summary'}</button>
          <button className="ghost" onClick={savePrompt}>Save as quick prompt</button>
        </div>
        {draft && (
          <div className="card draft" style={{ marginTop: 12 }}>
            <b>AI draft - not saved</b>
            <p className="mut">Review and edit if needed. Only accepted summaries are stored.</p>
            <textarea rows={10} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="ok" onClick={accept}>✓ Accept &amp; save as PDF</button>
              <button className="bad" onClick={reject}>✗ Reject</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Saved verified summaries</h3>
        {summaries.map((s) => (
          <div className="rep sum" key={s.id}>
            <b>{new Date(s.created_at).toLocaleString()}</b> · {s.doctor} · <a href={`/api/summaries/${s.id}/pdf`} target="_blank" rel="noreferrer">Open PDF</a>
            <div className="mut pre">{s.text.slice(0, 300)}{s.text.length > 300 ? '…' : ''}</div>
          </div>
        ))}
        {!summaries.length && <p className="mut">Nothing saved yet.</p>}
      </div>
    </>
  );
}

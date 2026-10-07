import { useEffect, useState } from 'react';
import { api } from './api';
import PatientView from './PatientView.jsx';

function AuthForm({ onDone }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', specialty: '', username: '', password: '', code: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const reg = mode === 'register';
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { onDone(await api(reg ? '/api/register' : '/api/login', { method: 'POST', body: f })); }
    catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <form className="card login" onSubmit={submit}>
      <h2>Med Review AI</h2>
      <p className="mut">{reg ? 'Create your doctor account' : 'Doctor sign in'}</p>
      {reg && <>
        <label htmlFor="n">Full name</label><input id="n" required value={f.name} onChange={set('name')} />
        <label htmlFor="s">Specialty</label><input id="s" value={f.specialty} onChange={set('specialty')} placeholder="e.g. Cardiology" />
      </>}
      <label htmlFor="u">Username</label><input id="u" required value={f.username} onChange={set('username')} autoComplete="username" />
      <label htmlFor="p">Password</label>
      <input id="p" type="password" required minLength={reg ? 8 : undefined} value={f.password} onChange={set('password')} autoComplete={reg ? 'new-password' : 'current-password'} />
      {reg && <>
        <label htmlFor="c">Hospital registration code</label><input id="c" required value={f.code} onChange={set('code')} />
      </>}
      <div className="err" role="alert">{err}</div>
      <button style={{ width: '100%' }} disabled={busy}>{busy ? 'Please wait…' : reg ? 'Create account' : 'Sign in'}</button>
      <p className="mut">
        {reg ? 'Already have an account? ' : 'New doctor? '}
        <a href="#" onClick={(e) => { e.preventDefault(); setErr(''); setMode(reg ? 'login' : 'register'); }}>{reg ? 'Sign in' : 'Create an account'}</a>
      </p>
    </form>
  );
}

function AddPatient({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', age: '', gender: '', contact: '', history: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api('/api/patients', { method: 'POST', body: { ...f, age: Number(f.age) } }); onSaved(r.id); }
    catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <div className="overlay" onClick={onClose}>
      <form className="card modal" role="dialog" aria-modal="true" aria-labelledby="apt" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 id="apt">Add new patient</h3>
        <div className="grid2">
          <div className="full"><label htmlFor="pn">Full name *</label><input id="pn" autoFocus required value={f.name} onChange={set('name')} /></div>
          <div><label htmlFor="pa">Age *</label><input id="pa" type="number" min="0" max="130" required value={f.age} onChange={set('age')} /></div>
          <div><label htmlFor="pg">Gender *</label>
            <select id="pg" required value={f.gender} onChange={set('gender')}>
              <option value="">Select…</option><option>Male</option><option>Female</option><option>Other</option>
            </select></div>
          <div className="full"><label htmlFor="pc">Contact number</label><input id="pc" type="tel" value={f.contact} onChange={set('contact')} /></div>
          <div className="full"><label htmlFor="ph">Medical history / allergies</label><textarea id="ph" rows={4} value={f.history} onChange={set('history')} /></div>
        </div>
        <div className="err" role="alert">{err}</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button disabled={busy}>{busy ? 'Saving…' : 'Save patient'}</button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [ready, setReady] = useState(false);
  const [patients, setPatients] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  const toast = (m) => { setToastMsg(m); setTimeout(() => setToastMsg(''), 3500); };
  const loadAll = async () => {
    const [p, pr, d] = await Promise.all([api('/api/patients'), api('/api/prompts'), api('/api/doctors')]);
    setPatients(p); setPrompts(pr); setDoctors(d);
  };
  useEffect(() => {
    api('/api/me').then((m) => { setMe(m); return loadAll(); }).catch(() => {}).finally(() => setReady(true));
  }, []);

  const onLogin = async (m) => { setMe(m); await loadAll(); };
  const logout = async () => { await api('/api/logout', { method: 'POST' }); setMe(null); setSel(null); };
  const saved = async (id) => { setAdding(false); setPatients(await api('/api/patients')); setSel(id); toast('Patient added'); };

  if (!ready) return null;
  if (!me) return <AuthForm onDone={onLogin} />;

  const list = patients.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  const selected = patients.find((p) => p.id === sel);

  return (
    <>
      <header>
        <b>Med Review AI</b>
        <span>{me.name}{me.specialty ? ` · ${me.specialty}` : ''} &nbsp; <button onClick={logout}>Sign out</button></span>
      </header>
      <div className="app">
        <aside className="card">
          <div className="row spread"><h3>Patients</h3><button className="ghost" onClick={() => setAdding(true)}>+ Add patient</button></div>
          <input placeholder="Search patients" aria-label="Search patients" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            {list.map((p) => (
              <div key={p.id} className={'pt' + (sel === p.id ? ' sel' : '')} tabIndex={0}
                onClick={() => setSel(p.id)} onKeyDown={(e) => e.key === 'Enter' && setSel(p.id)}>
                <b>{p.name}</b> <span className={'tag' + (p.mine ? ' mine' : '')}>{p.mine ? 'My patient' : 'Consult'}</span>
                <div className="mut">{p.age}y · {p.gender} · {p.primary_doctor}</div>
              </div>
            ))}
            {!list.length && <p className="mut">{patients.length ? 'No match.' : 'No patients yet. Click “Add patient” to start.'}</p>}
          </div>
        </aside>
        <section>
          {selected
            ? <PatientView id={selected.id} mine={!!selected.mine} prompts={prompts} doctors={doctors}
                reloadPrompts={async () => setPrompts(await api('/api/prompts'))} toast={toast} />
            : <div className="card mut">Select a patient to begin.</div>}
        </section>
      </div>
      {adding && <AddPatient onClose={() => setAdding(false)} onSaved={saved} />}
      {toastMsg && <div id="toast" role="status">{toastMsg}</div>}
    </>
  );
}

import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD = process.env.NODE_ENV === 'production';
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
if (PROD && !process.env.JWT_SECRET) throw new Error('JWT_SECRET is required in production');
const SECRET = process.env.JWT_SECRET || 'dev-only-secret';
const AI_URL = process.env.AI_BASE_URL || 'http://localhost:11434/v1';
const AI_KEY = process.env.AI_API_KEY || 'ollama';
const AI_MODEL = process.env.AI_MODEL || 'llama3.1:8b';
const AI_VISION = process.env.AI_VISION_MODEL || '';

// ---------- models (MongoDB) ----------
const { Schema, model } = mongoose;
const ref = (m) => ({ type: Schema.Types.ObjectId, ref: m });
const Doctor = model('Doctor', new Schema({
  name: String, specialty: String, passwordHash: String,
  username: { type: String, unique: true, lowercase: true, trim: true },
}, { timestamps: true }));
const Patient = model('Patient', new Schema({
  name: { type: String, required: true }, age: Number, gender: String, contact: String, history: String,
  primaryDoctor: { ...ref('Doctor'), index: true }, sharedWith: [ref('Doctor')],
}, { timestamps: true }));
const Report = model('Report', new Schema({
  patient: { ...ref('Patient'), index: true }, filename: String, mime: String, type: String,
  text: String, data: Buffer, uploadedBy: ref('Doctor'),
}, { timestamps: true }));
const Summary = model('Summary', new Schema({
  patient: { ...ref('Patient'), index: true }, doctor: ref('Doctor'), text: String, pdf: Buffer,
}, { timestamps: true }));
const Prompt = model('Prompt', new Schema({ title: String, text: String, owner: { ...ref('Doctor'), default: null } }));

await mongoose.connect(process.env.MONGODB_URI);
if (!(await Prompt.exists({ owner: null }))) {
  await Prompt.insertMany([
    { title: 'General summary', text: 'Summarize the key findings and the most likely main problem in plain clinical language.' },
    { title: 'Abnormal values', text: 'List all abnormal lab values or imaging findings with reference to normal ranges.' },
    { title: 'Radiology impression', text: 'Give a concise radiology-style impression and suggested follow-up imaging.' },
    { title: 'Consult brief', text: 'Write a 5-line brief for a consulting doctor: complaint, key findings, concerns, suggested next steps.' },
  ]);
}

// ---------- app + helpers ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const ok = mongoose.isValidObjectId;
const access = (id, did) => ({ _id: id, $or: [{ primaryDoctor: did }, { sharedWith: did }] });

const auth = (req, res, next) => {
  try { req.did = jwt.verify(req.cookies.token, SECRET).id; next(); }
  catch { res.status(401).json({ error: 'Not logged in' }); }
};
const guard = h(async (req, res, next) => {
  if (!ok(req.params.id) || !(await Patient.exists(access(req.params.id, req.did))))
    return res.status(403).json({ error: 'No access to this patient' });
  next();
});
const startSession = (res, d) => {
  res.cookie('token', jwt.sign({ id: String(d._id) }, SECRET, { expiresIn: '8h' }),
    { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 8 * 3600 * 1000 });
  return { id: d.id, name: d.name, specialty: d.specialty };
};

function extractText(buf, filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') return pdf(buf).then((r) => r.text).catch((e) => `[Could not extract text: ${e.message}]`);
  if (ext === 'txt') return Promise.resolve(buf.toString('utf8'));
  return Promise.resolve('');
}

function makePdf(p, doctor, text, names) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 }); const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.fontSize(20).text('Med Review AI - Verified Clinical Summary', { align: 'center' }).moveDown();
    doc.fontSize(11).text(`Patient: ${p.name} (${p.age ?? '-'}y, ${p.gender || '-'})`);
    doc.text(`Verified by: ${doctor}`).text(`Date: ${new Date().toUTCString()}`);
    doc.text(`Source reports: ${names.join(', ') || '-'}`).moveDown();
    doc.fontSize(12).text(text).moveDown(2);
    doc.fontSize(9).fillColor('gray').text('AI-assisted draft reviewed and approved by the doctor named above.');
    doc.end();
  });
}

async function callAI(prompt, images) {
  const content = images.length
    ? [{ type: 'text', text: prompt }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data.toString('base64')}` } }))]
    : prompt;
  const r = await fetch(`${AI_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
    body: JSON.stringify({
      model: images.length ? AI_VISION : AI_MODEL, temperature: 0.2,
      messages: [
        { role: 'system', content: 'You assist doctors by drafting clinical summaries from patient reports. Never invent findings. A doctor will verify your draft.' },
        { role: 'user', content },
      ],
    }),
  });
  if (!r.ok) throw new Error(`AI service returned ${r.status}`);
  return (await r.json()).choices[0].message.content.trim();
}

// ---------- auth ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/register', authLimit, h(async (req, res) => {
  const { name, username, password, specialty, code } = req.body || {};
  if (!process.env.REGISTRATION_CODE) return res.status(403).json({ error: 'Registration is disabled' });
  if (code !== process.env.REGISTRATION_CODE) return res.status(403).json({ error: 'Invalid hospital registration code' });
  if (!name?.trim() || !username?.trim()) return res.status(400).json({ error: 'Name and username are required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (await Doctor.exists({ username: username.toLowerCase().trim() })) return res.status(409).json({ error: 'Username already taken' });
  const d = await Doctor.create({ name: name.trim(), username, specialty: specialty?.trim(), passwordHash: await bcrypt.hash(password, 10) });
  res.json(startSession(res, d));
}));

app.post('/api/login', authLimit, h(async (req, res) => {
  const { username, password } = req.body || {};
  const d = await Doctor.findOne({ username: String(username || '').toLowerCase().trim() });
  if (!d || !(await bcrypt.compare(String(password || ''), d.passwordHash))) return res.status(401).json({ error: 'Invalid username or password' });
  res.json(startSession(res, d));
}));
app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/me', auth, h(async (req, res) => {
  const d = await Doctor.findById(req.did);
  if (!d) return res.status(401).json({ error: 'Not logged in' });
  res.json({ id: d.id, name: d.name, specialty: d.specialty });
}));

// ---------- patients ----------
app.get('/api/patients', auth, h(async (req, res) => {
  const ps = await Patient.find({ $or: [{ primaryDoctor: req.did }, { sharedWith: req.did }] }).populate('primaryDoctor', 'name').sort('name');
  res.json(ps.map((p) => ({
    id: p.id, name: p.name, age: p.age, gender: p.gender, contact: p.contact, history: p.history,
    primary_doctor: p.primaryDoctor?.name, mine: String(p.primaryDoctor?._id) === req.did,
  })));
}));
app.post('/api/patients', auth, h(async (req, res) => {
  const { name, age, gender, contact, history } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Patient name is required' });
  if (!(age >= 0 && age <= 130)) return res.status(400).json({ error: 'Enter a valid age (0-130)' });
  if (!['Male', 'Female', 'Other'].includes(gender)) return res.status(400).json({ error: 'Select a gender' });
  const p = await Patient.create({ name: name.trim(), age, gender, contact: contact?.trim(), history: history?.trim(), primaryDoctor: req.did });
  res.json({ id: p.id });
}));
app.get('/api/patients/:id', auth, guard, h(async (req, res) => {
  const [p, reps, sums] = await Promise.all([
    Patient.findById(req.params.id),
    Report.find({ patient: req.params.id }).select('-data -text').sort('-createdAt'),
    Summary.find({ patient: req.params.id }).select('-pdf').populate('doctor', 'name').sort('-createdAt'),
  ]);
  res.json({
    patient: { id: p.id, name: p.name, age: p.age, gender: p.gender, contact: p.contact, history: p.history },
    reports: reps.map((r) => ({ id: r.id, filename: r.filename, type: r.type, created_at: r.createdAt })),
    summaries: sums.map((s) => ({ id: s.id, text: s.text, doctor: s.doctor?.name, created_at: s.createdAt })),
  });
}));
app.get('/api/doctors', auth, h(async (req, res) => {
  const ds = await Doctor.find({ _id: { $ne: req.did } }).select('name specialty').sort('name');
  res.json(ds.map((d) => ({ id: d.id, name: d.name, specialty: d.specialty })));
}));
app.post('/api/patients/:id/consult', auth, h(async (req, res) => {
  const { doctor_id } = req.body || {};
  if (!ok(req.params.id) || !ok(doctor_id)) return res.status(400).json({ error: 'Invalid id' });
  const r = await Patient.updateOne({ _id: req.params.id, primaryDoctor: req.did }, { $addToSet: { sharedWith: doctor_id } });
  if (!r.matchedCount) return res.status(403).json({ error: 'Only the primary doctor can share a patient' });
  res.json({ ok: true });
}));

// ---------- reports (files stored inside MongoDB, so no disk needed on free hosting) ----------
const MIMES = { pdf: 'application/pdf', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, f, cb) => MIMES[f.originalname.toLowerCase().split('.').pop()]
    ? cb(null, true) : cb(new Error('Only PDF, TXT, PNG and JPG files are allowed')),
});
app.post('/api/patients/:id/reports', auth, guard, upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const name = req.file.originalname;
  const r = await Report.create({
    patient: req.params.id, filename: name, mime: MIMES[name.toLowerCase().split('.').pop()],
    type: req.body.type || 'Report', text: await extractText(req.file.buffer, name), data: req.file.buffer, uploadedBy: req.did,
  });
  res.json({ id: r.id });
}));
app.get('/api/reports/:rid/file', auth, h(async (req, res) => {
  const r = ok(req.params.rid) && await Report.findById(req.params.rid);
  if (!r || !(await Patient.exists(access(r.patient, req.did)))) return res.status(403).json({ error: 'No access' });
  res.set({ 'Content-Type': r.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.filename)}` }).send(r.data);
}));

// ---------- prompts ----------
app.get('/api/prompts', auth, h(async (req, res) => {
  const ps = await Prompt.find({ $or: [{ owner: null }, { owner: req.did }] });
  res.json(ps.map((p) => ({ id: p.id, title: p.title, text: p.text })));
}));
app.post('/api/prompts', auth, h(async (req, res) => {
  const { title, text } = req.body || {};
  if (!title?.trim() || !text?.trim()) return res.status(400).json({ error: 'Title and text required' });
  await Prompt.create({ title: title.trim(), text: text.trim(), owner: req.did });
  res.json({ ok: true });
}));

// ---------- AI draft (never stored) ----------
app.post('/api/patients/:id/ai-summary', auth, guard, h(async (req, res) => {
  const ids = (req.body.report_ids || []).filter(ok);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one report' });
  const p = await Patient.findById(req.params.id);
  const reps = await Report.find({ patient: p._id, _id: { $in: ids } });
  const ctx = reps.map((r) => `### ${r.type}: ${r.filename}\n${(r.text || '[no extractable text]').slice(0, 6000)}`).join('\n\n');
  const images = AI_VISION ? reps.filter((r) => r.mime.startsWith('image/')).slice(0, 4) : [];
  const prompt = `Patient: ${p.name}, ${p.age}y ${p.gender}. History: ${p.history || 'none given'}.\n` +
    `Task: ${req.body.prompt || 'Summarize the main problem.'}\n` +
    'Use only the information in the reports. If data is missing, say so.\n\n' + ctx;
  try { res.json({ draft: await callAI(prompt, images) }); }
  catch (e) { res.status(503).json({ error: `AI service unavailable (${e.message}). Check AI_BASE_URL / AI_API_KEY.` }); }
}));

// ---------- accept = save PDF + text. Reject = nothing stored ----------
app.post('/api/patients/:id/summaries', auth, guard, h(async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty summary' });
  const [p, d] = await Promise.all([Patient.findById(req.params.id), Doctor.findById(req.did)]);
  const ids = (req.body.report_ids || []).filter(ok);
  const names = (await Report.find({ patient: p._id, _id: { $in: ids } }).select('filename')).map((r) => r.filename);
  const s = await Summary.create({ patient: p._id, doctor: d._id, text, pdf: await makePdf(p, d.name, text, names) });
  res.json({ id: s.id });
}));
app.get('/api/summaries/:sid/pdf', auth, h(async (req, res) => {
  const s = ok(req.params.sid) && await Summary.findById(req.params.sid);
  if (!s || !(await Patient.exists(access(s.patient, req.did)))) return res.status(403).json({ error: 'No access' });
  res.type('application/pdf').send(s.pdf);
}));

// ---------- serve the React build (single deployment) ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
const dist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.use((err, req, res, next) => res.status(400).json({ error: err.message }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Med Review AI running on port ${PORT}`));

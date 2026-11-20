const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('database schema defines duplicate-answer protection', () => {
  const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
  assert.match(schema, /UNIQUE KEY uq_answer_once \(session_id, student_id, question_id\)/);
  assert.match(schema, /UNIQUE KEY uq_session_student \(session_id, student_id\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS session_scores/);
});

test('frontend exposes the core game screens', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(html, /QuizArena/);
  assert.match(app, /answer:submit/);
  assert.match(app, /leaderboard:update/);
  assert.match(app, /game:finished/);
});

test('quiz management separates edit, publish, unpublish, and delete actions', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(server, /app\.put\('\/api\/quizzes\/:id'/);
  assert.match(server, /app\.post\('\/api\/quizzes\/:id\/publish'/);
  assert.match(server, /app\.post\('\/api\/quizzes\/:id\/unpublish'/);
  assert.match(server, /app\.delete\('\/api\/quizzes\/:id'/);
  assert.match(server, /Unpublish this quiz before deleting it/);
  assert.match(app, /data-unpublish/);
  assert.match(app, /confirm\('Delete this quiz\?/);
});

test('authentication routes use an in-memory rate limiter', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /app\.post\('\/api\/auth\/register', authRateLimit/);
  assert.match(server, /app\.post\('\/api\/auth\/login', authRateLimit/);
  assert.match(server, /status\(429\)/);
});

test('quiz edits preserve historical question rows and create a current version', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
  const editRoute = server.slice(server.indexOf("app.put('/api/quizzes/:id'"), server.indexOf('async function saveQuestions'));
  assert.match(editRoute, /UPDATE questions SET is_current=FALSE/);
  assert.match(editRoute, /saveQuestions\(connection, quizId, questions\)/);
  assert.doesNotMatch(editRoute, /DELETE FROM questions/);
  assert.match(server, /is_current=TRUE ORDER BY position/);
  assert.match(schema, /is_current BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(schema, /FOREIGN KEY \(question_id\) REFERENCES questions\(id\)/);
});

test('editing a quiz with history requires explicit confirmation in the frontend', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(server, /AS hasGameHistory/);
  assert.match(app, /You are editing a quiz with existing game history\. Your changes will apply to future game sessions\. Previous game records and results will remain unchanged\./);
  assert.match(app, /id="cancelHistoryEdit"/);
  assert.match(app, /id="confirmHistoryEdit"/);
  assert.match(app, /data-unpublish/);
});

require('dotenv').config();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-this-secret';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'quizarena',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true
});

const rooms = new Map();
const authAttempts = new Map();

function authRateLimit(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  let attempts = authAttempts.get(key);
  if (!attempts || now - attempts.startedAt >= windowMs) {
    attempts = { startedAt: now, count: 0 };
  }
  attempts.count++;
  authAttempts.set(key, attempts);
  if (attempts.count > 20) {
    res.set('Retry-After', String(Math.ceil((windowMs - (now - attempts.startedAt)) / 1000)));
    return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
  }
  next();
}

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, attempts] of authAttempts) {
    if (attempts.startedAt < cutoff) authAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref();

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '12h' });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) return res.status(403).json({ error: 'You do not have permission for this action.' });
    next();
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function normalizeRoomCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-F0-9]{6}$/.test(code) ? code : null;
}

function validateQuizQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) return 'Add at least one question.';
  if (questions.length > 100) return 'A quiz can have at most 100 questions.';
  for (const item of questions) {
    if (!item || typeof item !== 'object') return 'Question data is invalid.';
    const text = String(item.text || '').trim();
    const choices = Array.isArray(item.choices) ? item.choices : [];
    const correctIndex = Number(item.correctIndex);
    const timeLimit = Number(item.timeLimit);
    if (!text || choices.length !== 4 || !choices.every(choice => {
      if (!choice || typeof choice !== 'object') return false;
      const choiceText = String(choice.text || '').trim();
      return choiceText.length > 0 && choiceText.length <= 500;
    })) {
      return 'Each question needs text and four answer choices (500 characters maximum per choice).';
    }
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      return 'Choose one correct answer for every question.';
    }
    if (!Number.isInteger(timeLimit) || timeLimit < 5 || timeLimit > 120) {
      return 'Question time limits must be between 5 and 120 seconds.';
    }
  }
  return null;
}

async function getLeaderboard(sessionId) {
  const [rows] = await pool.query(
    `SELECT u.id, u.name,
      s.total_score AS totalScore,
      s.correct_answers AS correctAnswers,
      s.total_response_time_ms AS totalResponseTime,
      COUNT(a.id) AS answersSubmitted,
      SUM(CASE WHEN a.is_correct = FALSE THEN 1 ELSE 0 END) AS incorrectAnswers
     FROM session_scores s
     JOIN users u ON u.id = s.student_id
     LEFT JOIN student_answers a ON a.session_id = s.session_id AND a.student_id = s.student_id
     WHERE s.session_id = ?
     GROUP BY u.id, u.name, s.total_score, s.correct_answers, s.total_response_time_ms
     ORDER BY s.total_score DESC, s.total_response_time_ms ASC, u.name ASC`,
    [sessionId]
  );
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function getPublicQuestion(room) {
  if (!room || room.questionIndex >= room.questions.length) return null;
  const question = room.questions[room.questionIndex];
  return {
    id: question.id,
    text: question.text,
    timeLimit: question.timeLimit,
    position: room.questionIndex + 1,
    total: room.questions.length,
    remainingMs: Math.max(0, room.deadlineAt - Date.now()),
    choices: question.choices.map(({ id, text, position }) => ({ id, text, position }))
  };
}

async function getSessionParticipants(sessionId) {
  const [rows] = await pool.query(
    `SELECT u.id, u.name
     FROM session_participants p
     JOIN users u ON u.id = p.student_id
     WHERE p.session_id = ?
     ORDER BY p.joined_at, u.name`,
    [sessionId]
  );
  return rows;
}

async function getLobbyParticipants(sessionId, roomCode) {
  const [participants, roomSockets] = await Promise.all([
    getSessionParticipants(sessionId),
    io.in(roomCode).fetchSockets()
  ]);
  const onlineIds = new Set(roomSockets.filter(item => item.data.userRole === 'student').map(item => String(item.data.userId)));
  return participants.map(person => ({ ...person, connected: onlineIds.has(String(person.id)) }));
}

function getLiveSessionState(room) {
  if (!room || room.status !== 'active') return null;
  return {
    question: getPublicQuestion(room),
    submittedAnswers: room.submitted.size,
    questionNumber: room.questionIndex + 1,
    totalQuestions: room.questions.length
  };
}

async function getQuestionList(quizId) {
  const [questions] = await pool.query(
    'SELECT id, question_text AS text, time_limit AS timeLimit, position FROM questions WHERE quiz_id = ? AND is_current=TRUE ORDER BY position',
    [quizId]
  );
  for (const question of questions) {
    const [choices] = await pool.query(
      'SELECT id, choice_text AS text, position, is_correct AS isCorrect FROM answer_choices WHERE question_id = ? ORDER BY position',
      [question.id]
    );
    question.choices = choices;
  }
  return questions;
}

async function broadcastLeaderboard(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const leaderboard = await getLeaderboard(room.sessionId);
  io.to(roomCode).emit('leaderboard:update', { leaderboard });
}

async function endGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.timer) clearTimeout(room.timer);
  await pool.query("UPDATE game_sessions SET status='finished', ended_at=CURRENT_TIMESTAMP WHERE id=?", [room.sessionId]);
  const leaderboard = await getLeaderboard(room.sessionId);
  io.to(roomCode).emit('game:finished', { leaderboard });
  room.status = 'finished';
}

async function sendQuestion(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.questionIndex >= room.questions.length) {
    await endGame(roomCode);
    return;
  }

  const question = room.questions[room.questionIndex];
  room.currentQuestionId = question.id;
  room.questionStartedAt = Date.now();
  room.timeExpired = false;
  room.submitted = new Set();
  room.deadlineAt = room.questionStartedAt + question.timeLimit * 1000;
  const publicQuestion = getPublicQuestion(room);

  io.to(roomCode).emit('game:question', publicQuestion);
  io.to(roomCode).emit('game:progress', {
    questionNumber: room.questionIndex + 1,
    totalQuestions: room.questions.length,
    submittedAnswers: 0
  });

  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    room.timeExpired = true;
    io.to(roomCode).emit('question:timeup', { questionId: question.id });
  }, question.timeLimit * 1000);
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = req.body.role;
    if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
    if (!validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!['teacher', 'student'].includes(role)) return res.status(400).json({ error: 'Choose a valid role.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      'INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)',
      [name, email, passwordHash, role]
    );
    const user = { id: result.insertId, name, role };
    res.status(201).json({ token: signToken(user), user });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An account with this email already exists.' });
    console.error(error);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const [rows] = await pool.query('SELECT id,name,email,password_hash,role FROM users WHERE email=?', [email]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const user = { id: rows[0].id, name: rows[0].name, role: rows[0].role };
    res.json({ token: signToken(user), user });
  } catch (error) {
    console.error('Could not complete login:', error);
    res.status(500).json({ error: 'Could not log in. Please try again.' });
  }
});

app.get('/api/me', authenticate, async (req, res) => {
  const [rows] = await pool.query('SELECT id,name,email,role,created_at AS createdAt FROM users WHERE id=?', [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: rows[0] });
});

app.get('/api/quizzes', authenticate, requireRole('teacher'), async (req, res) => {
  const [quizzes] = await pool.query(
    'SELECT id,title,description,is_published AS isPublished,created_at AS createdAt FROM quizzes WHERE teacher_id=? ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ quizzes });
});

app.post('/api/quizzes', authenticate, requireRole('teacher'), async (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!title) return res.status(400).json({ error: 'Quiz title is required.' });
  if (title.length > 180) return res.status(400).json({ error: 'Quiz title must be 180 characters or less.' });
  const validationError = validateQuizQuestions(questions);
  if (validationError) return res.status(400).json({ error: validationError });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [quizResult] = await connection.query(
      'INSERT INTO quizzes (teacher_id,title,description,is_published) VALUES (?,?,?,FALSE)',
      [req.user.id, title, description]
    );
    const quizId = quizResult.insertId;
    await saveQuestions(connection, quizId, questions);
    await connection.commit();
    res.status(201).json({ quiz: { id: quizId, title, description } });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Could not roll back quiz creation:', rollbackError);
      }
    }
    console.error(error);
    res.status(500).json({ error: 'Could not save the quiz.' });
  } finally {
    if (connection) connection.release();
  }
});

app.put('/api/quizzes/:id', authenticate, requireRole('teacher'), async (req, res) => {
  const quizId = Number(req.params.id);
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!title) return res.status(400).json({ error: 'Quiz title is required.' });
  if (title.length > 180) return res.status(400).json({ error: 'Quiz title must be 180 characters or less.' });
  const validationError = validateQuizQuestions(questions);
  if (validationError) return res.status(400).json({ error: validationError });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [owned] = await connection.query(
      'SELECT id,is_published AS isPublished FROM quizzes WHERE id=? AND teacher_id=? FOR UPDATE',
      [quizId, req.user.id]
    );
    if (!owned.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Quiz not found.' });
    }
    await connection.query('UPDATE questions SET is_current=FALSE WHERE quiz_id=? AND is_current=TRUE', [quizId]);
    await connection.query('UPDATE quizzes SET title=?,description=? WHERE id=?', [title, description, quizId]);
    await saveQuestions(connection, quizId, questions);
    await connection.commit();
    res.json({ quiz: { id: quizId, title, description } });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Could not roll back quiz update:', rollbackError);
      }
    }
    console.error(error);
    res.status(500).json({ error: 'Could not update the quiz.' });
  } finally {
    if (connection) connection.release();
  }
});

async function saveQuestions(connection, quizId, questions) {
  for (let index = 0; index < questions.length; index++) {
    const item = questions[index];
    const text = String(item.text || '').trim();
    const choices = Array.isArray(item.choices) ? item.choices : [];
    const timeLimit = Math.min(120, Math.max(5, Number(item.timeLimit || 20)));
    const correctIndex = Number(item.correctIndex);
    if (!text || choices.length !== 4 || !choices.every(choice => String(choice.text || '').trim())) {
      throw new Error('Each question must have text and four answer choices.');
    }
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      throw new Error('A correct answer is required for every question.');
    }
    const [questionResult] = await connection.query(
      'INSERT INTO questions (quiz_id,question_text,time_limit,position) VALUES (?,?,?,?)',
      [quizId, text, timeLimit, index]
    );
    for (let choiceIndex = 0; choiceIndex < 4; choiceIndex++) {
      await connection.query(
        'INSERT INTO answer_choices (question_id,choice_text,position,is_correct) VALUES (?,?,?,?)',
        [questionResult.insertId, String(choices[choiceIndex].text).trim(), choiceIndex, choiceIndex === correctIndex]
      );
    }
  }
}

app.get('/api/quizzes/:id', authenticate, requireRole('teacher'), async (req, res) => {
  const quizId = Number(req.params.id);
  const [rows] = await pool.query(
    `SELECT id,title,description,is_published AS isPublished,
       EXISTS(SELECT 1 FROM game_sessions WHERE quiz_id=quizzes.id) AS hasGameHistory
     FROM quizzes WHERE id=? AND teacher_id=?`,
    [quizId, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Quiz not found.' });
  const questions = await getQuestionList(quizId);
  res.json({ quiz: rows[0], questions });
});

app.post('/api/quizzes/:id/publish', authenticate, requireRole('teacher'), async (req, res) => {
  const quizId = Number(req.params.id);
  const [owned] = await pool.query(
    'SELECT id FROM quizzes WHERE id=? AND teacher_id=?',
    [quizId, req.user.id]
  );
  if (!owned.length) return res.status(404).json({ error: 'Quiz not found.' });
  const [result] = await pool.query(
    'UPDATE quizzes SET is_published=TRUE WHERE id=? AND teacher_id=?',
    [quizId, req.user.id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Quiz not found.' });
  res.json({ published: true });
});

app.post('/api/quizzes/:id/unpublish', authenticate, requireRole('teacher'), async (req, res) => {
  const quizId = Number(req.params.id);
  const [result] = await pool.query(
    'UPDATE quizzes SET is_published=FALSE WHERE id=? AND teacher_id=?',
    [quizId, req.user.id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'Quiz not found.' });
  res.json({ published: false });
});

app.delete('/api/quizzes/:id', authenticate, requireRole('teacher'), async (req, res) => {
  const quizId = Number(req.params.id);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [owned] = await connection.query(
      'SELECT id,is_published AS isPublished FROM quizzes WHERE id=? AND teacher_id=? FOR UPDATE',
      [quizId, req.user.id]
    );
    if (!owned.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Quiz not found.' });
    }
    if (owned[0].isPublished) {
      await connection.rollback();
      return res.status(409).json({ error: 'Unpublish this quiz before deleting it.' });
    }
    const [sessions] = await connection.query('SELECT id FROM game_sessions WHERE quiz_id=? LIMIT 1', [quizId]);
    if (sessions.length) {
      await connection.rollback();
      return res.status(409).json({ error: 'This quiz has game history and cannot be deleted.' });
    }
    await connection.query('DELETE FROM quizzes WHERE id=? AND teacher_id=?', [quizId, req.user.id]);
    await connection.commit();
    res.json({ deleted: true });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Could not roll back quiz deletion:', rollbackError);
      }
    }
    console.error(error);
    res.status(500).json({ error: 'Could not delete the quiz.' });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/sessions', authenticate, requireRole('teacher'), async (req, res) => {
  const quizId = Number(req.body.quizId);
  const [quizRows] = await pool.query(
    'SELECT id,title FROM quizzes WHERE id=? AND teacher_id=?',
    [quizId, req.user.id]
  );
  if (!quizRows.length) return res.status(404).json({ error: 'Quiz not found.' });
  const [questionRows] = await pool.query('SELECT id FROM questions WHERE quiz_id=?', [quizId]);
  if (!questionRows.length) return res.status(400).json({ error: 'This quiz has no questions.' });

  let roomCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    roomCode = makeRoomCode();
    try {
      const [result] = await pool.query(
        'INSERT INTO game_sessions (quiz_id,teacher_id,quiz_title,room_code,status) VALUES (?,?,?,?,\'lobby\')',
        [quizId, req.user.id, quizRows[0].title, roomCode]
      );
      rooms.set(roomCode, { sessionId: result.insertId, teacherId: req.user.id, status: 'lobby' });
      return res.status(201).json({ sessionId: result.insertId, roomCode, quizTitle: quizRows[0].title });
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
    }
  }
  res.status(500).json({ error: 'Could not generate a unique room code.' });
});

app.get('/api/sessions', authenticate, requireRole('teacher'), async (req, res) => {
  const [sessions] = await pool.query(
    `SELECT s.id,s.room_code AS roomCode,s.status,s.created_at AS createdAt,s.quiz_title AS title
     FROM game_sessions s
     WHERE s.teacher_id=? ORDER BY s.created_at DESC`,
    [req.user.id]
  );
  res.json({ sessions });
});

app.get('/api/sessions/:id/results', authenticate, async (req, res) => {
  const sessionId = Number(req.params.id);
  const [sessionRows] = await pool.query(
    'SELECT id,teacher_id AS teacherId,room_code AS roomCode,status FROM game_sessions WHERE id=?',
    [sessionId]
  );
  if (!sessionRows.length) return res.status(404).json({ error: 'Session not found.' });
  if (req.user.role === 'teacher' && sessionRows[0].teacherId !== req.user.id) {
    return res.status(403).json({ error: 'You do not have permission to view these results.' });
  }
  if (req.user.role === 'student') {
    const [participantRows] = await pool.query(
      'SELECT id FROM session_participants WHERE session_id=? AND student_id=?',
      [sessionId, req.user.id]
    );
    if (!participantRows.length) return res.status(403).json({ error: 'You did not participate in this game.' });
  }
  res.json({ session: sessionRows[0], leaderboard: await getLeaderboard(sessionId) });
});

app.get('/api/student/history', authenticate, requireRole('student'), async (req, res) => {
  const [history] = await pool.query(
    `SELECT s.id,s.room_code AS roomCode,s.status,s.quiz_title AS title,
      COALESCE(sc.total_score,0) AS totalScore,
      COALESCE(sc.correct_answers,0) AS correctAnswers
     FROM session_participants p
     JOIN game_sessions s ON s.id=p.session_id
     LEFT JOIN session_scores sc ON sc.session_id=s.id AND sc.student_id=p.student_id
     WHERE p.student_id=? ORDER BY s.created_at DESC LIMIT 20`,
    [req.user.id]
  );
  res.json({ history });
});

app.get('/api/student/overview', authenticate, requireRole('student'), async (req, res) => {
  const [summaryRows] = await pool.query(
    `SELECT
       COALESCE(SUM(sc.total_score), 0) AS totalPoints,
       COALESCE(SUM(sc.correct_answers), 0) AS correctAnswers,
       COALESCE(SUM(answer_totals.total_answers), 0) AS totalAnswers,
       COUNT(DISTINCT CASE WHEN gs.status='finished' THEN gs.id END) AS gamesPlayed
     FROM session_participants p
     LEFT JOIN game_sessions gs ON gs.id=p.session_id
     LEFT JOIN session_scores sc ON sc.session_id=p.session_id AND sc.student_id=p.student_id
     LEFT JOIN (
       SELECT session_id, student_id, COUNT(*) AS total_answers
       FROM student_answers GROUP BY session_id, student_id
     ) answer_totals ON answer_totals.session_id=p.session_id AND answer_totals.student_id=p.student_id
     WHERE p.student_id=?`,
    [req.user.id]
  );
  const summary = summaryRows[0];
  const [rankRows] = await pool.query(
    `SELECT COUNT(*) + 1 AS currentRank
     FROM (
       SELECT u.id, COALESCE(SUM(sc.total_score),0) AS points
       FROM users u LEFT JOIN session_scores sc ON sc.student_id=u.id
       WHERE u.role='student'
       GROUP BY u.id
     ) totals
     WHERE totals.points > ?`,
    [summary.totalPoints]
  );
  const [history] = await pool.query(
    `SELECT gs.id, gs.status, gs.quiz_title AS title, gs.created_at AS playedAt,
       COALESCE(sc.total_score,0) AS totalScore,
       COALESCE(sc.correct_answers,0) AS correctAnswers
     FROM session_participants p
     JOIN game_sessions gs ON gs.id=p.session_id
     LEFT JOIN session_scores sc ON sc.session_id=gs.id AND sc.student_id=p.student_id
     WHERE p.student_id=? ORDER BY gs.created_at DESC LIMIT 5`,
    [req.user.id]
  );
  const [personalBestRows] = await pool.query(
    `SELECT COALESCE(MAX(sc.total_score),0) AS personalBest
     FROM session_scores sc WHERE sc.student_id=?`,
    [req.user.id]
  );

  res.json({
    summary: {
      ...summary,
      currentRank: summary.gamesPlayed > 0 ? rankRows[0].currentRank : null,
      personalBest: personalBestRows[0].personalBest,
      accuracy: Number(summary.totalAnswers) > 0
        ? Math.round((Number(summary.correctAnswers) / Number(summary.totalAnswers)) * 100)
        : 0
    },
    history
  });
});

app.get('/api/teacher/overview', authenticate, requireRole('teacher'), async (req, res) => {
  const [summaryRows] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM quizzes WHERE teacher_id=?) AS totalQuizzes,
       (SELECT COUNT(*) FROM game_sessions WHERE teacher_id=? AND status='active') AS activeSessions,
       (SELECT COUNT(*) FROM session_participants p JOIN game_sessions gs ON gs.id=p.session_id WHERE gs.teacher_id=?) AS totalParticipants`,
    [req.user.id, req.user.id, req.user.id]
  );
  const [recentQuizzes] = await pool.query(
    `SELECT q.id, q.title, q.is_published AS isPublished, q.created_at AS createdAt,
       COUNT(DISTINCT gs.id) AS sessionCount,
       COUNT(DISTINCT p.id) AS participantCount
     FROM quizzes q
     LEFT JOIN game_sessions gs ON gs.quiz_id=q.id
     LEFT JOIN session_participants p ON p.session_id=gs.id
     WHERE q.teacher_id=?
     GROUP BY q.id, q.title, q.is_published, q.created_at
     ORDER BY q.created_at DESC LIMIT 5`,
    [req.user.id]
  );
  res.json({ summary: summaryRows[0], recentQuizzes });
});

app.get('/api/admin/overview', authenticate, requireRole('admin'), async (req, res) => {
  const [summaryRows] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM users) AS totalUsers,
       (SELECT COUNT(*) FROM users WHERE role='teacher') AS teachers,
       (SELECT COUNT(*) FROM users WHERE role='student') AS students,
       (SELECT COUNT(*) FROM quizzes) AS totalQuizzes,
       (SELECT COUNT(*) FROM game_sessions) AS totalSessions,
       (SELECT COUNT(*) FROM game_sessions WHERE status='active') AS activeSessions,
       (SELECT COUNT(*) FROM session_participants) AS playerJoins`
  );
  const [recentSessions] = await pool.query(
    `SELECT gs.id,gs.room_code AS roomCode,gs.status,gs.created_at AS createdAt,
       gs.quiz_title AS quizTitle,u.name AS teacherName,COUNT(DISTINCT p.student_id) AS participantCount
     FROM game_sessions gs
     JOIN quizzes q ON q.id=gs.quiz_id
     JOIN users u ON u.id=gs.teacher_id
     LEFT JOIN session_participants p ON p.session_id=gs.id
     GROUP BY gs.id,gs.room_code,gs.status,gs.created_at,gs.quiz_title,u.name
     ORDER BY gs.created_at DESC LIMIT 8`
  );
  res.json({
    summary: summaryRows[0],
    recentSessions,
    system: { database: 'connected', uptimeSeconds: Math.floor(process.uptime()) }
  });
});

app.get('/api/admin/users', authenticate, requireRole('admin'), async (req, res) => {
  const role = String(req.query.role || 'all');
  const search = String(req.query.search || '').trim().slice(0, 100);
  if (!['all', 'teacher', 'student', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Choose a valid user role filter.' });
  }
  const filters = [];
  const params = [];
  if (role !== 'all') {
    filters.push('u.role=?');
    params.push(role);
  }
  if (search) {
    filters.push('(u.name LIKE ? OR u.email LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const [users] = await pool.query(
    `SELECT u.id,u.name,u.email,u.role,u.created_at AS createdAt,
       COUNT(DISTINCT p.id) AS sessionsJoined
     FROM users u
     LEFT JOIN session_participants p ON p.student_id=u.id
     ${where}
     GROUP BY u.id,u.name,u.email,u.role,u.created_at
     ORDER BY u.created_at DESC LIMIT 100`,
    params
  );
  res.json({ users });
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid authentication'));
  }
});

io.on('connection', socket => {
  socket.data.userId = socket.user.id;
  socket.data.userRole = socket.user.role;

  socket.on('game:join', async ({ roomCode }, callback) => {
    try {
      if (socket.user.role !== 'student') throw new Error('Only students can join a game.');
      const code = normalizeRoomCode(roomCode);
      if (!code) throw new Error('Enter a valid six-character room code.');
      const [rows] = await pool.query(
        `SELECT gs.id,gs.quiz_id AS quizId,gs.status,gs.quiz_title AS quizTitle,u.name AS teacherName
         FROM game_sessions gs JOIN quizzes q ON q.id=gs.quiz_id
         JOIN users u ON u.id=gs.teacher_id WHERE gs.room_code=?`,
        [code]
      );
      if (!rows.length) throw new Error('No game was found with that room code.');
      if (rows[0].status === 'finished') {
        const [participantRows] = await pool.query(
          'SELECT id FROM session_participants WHERE session_id=? AND student_id=?',
          [rows[0].id, socket.user.id]
        );
        if (!participantRows.length) throw new Error('This game has already finished.');
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.sessionId = rows[0].id;
        callback?.({
          ok: true,
          sessionId: rows[0].id,
          status: 'finished',
          quizTitle: rows[0].quizTitle,
          teacherName: rows[0].teacherName,
          participants: await getLobbyParticipants(rows[0].id, code),
          leaderboard: await getLeaderboard(rows[0].id)
        });
        return;
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(
          'INSERT IGNORE INTO session_participants (session_id,student_id) VALUES (?,?)',
          [rows[0].id, socket.user.id]
        );
        await connection.query(
          'INSERT IGNORE INTO session_scores (session_id,student_id,total_score,correct_answers,total_response_time_ms) VALUES (?, ?, 0, 0, 0)',
          [rows[0].id, socket.user.id]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.sessionId = rows[0].id;
      const participants = await getLobbyParticipants(rows[0].id, code);
      io.to(code).emit('lobby:participants', {
        participants,
        quizTitle: rows[0].quizTitle,
        teacherName: rows[0].teacherName
      });
      callback?.({
        ok: true,
        sessionId: rows[0].id,
        status: rows[0].status,
        quizTitle: rows[0].quizTitle,
        teacherName: rows[0].teacherName,
        participants,
        liveState: getLiveSessionState(rooms.get(code)),
        leaderboard: rows[0].status !== 'lobby' ? await getLeaderboard(rows[0].id) : []
      });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on('teacher:join_lobby', async ({ roomCode }, callback) => {
    try {
      if (socket.user.role !== 'teacher') throw new Error('Only teachers can host a game.');
      const code = normalizeRoomCode(roomCode);
      if (!code) throw new Error('Enter a valid six-character room code.');
      const [rows] = await pool.query(
        `SELECT gs.id,gs.teacher_id AS teacherId,gs.status,gs.quiz_title AS quizTitle,u.name AS teacherName
         FROM game_sessions gs JOIN quizzes q ON q.id=gs.quiz_id
         JOIN users u ON u.id=gs.teacher_id WHERE gs.room_code=?`,
        [code]
      );
      if (!rows.length || rows[0].teacherId !== socket.user.id) throw new Error('Game session not found.');
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.sessionId = rows[0].id;
      callback?.({
        ok: true,
        participants: await getLobbyParticipants(rows[0].id, code),
        status: rows[0].status,
        quizTitle: rows[0].quizTitle,
        teacherName: rows[0].teacherName,
        liveState: getLiveSessionState(rooms.get(code)),
        leaderboard: rows[0].status !== 'lobby' ? await getLeaderboard(rows[0].id) : []
      });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on('game:start', async ({ roomCode }) => {
    try {
      const code = normalizeRoomCode(roomCode);
      if (!code) throw new Error('Enter a valid six-character room code.');
      const [rows] = await pool.query(
        'SELECT id,quiz_id AS quizId,teacher_id AS teacherId,status FROM game_sessions WHERE room_code=?',
        [code]
      );
      if (!rows.length || rows[0].teacherId !== socket.user.id) throw new Error('Not authorized to start this game.');
      if (socket.user.role !== 'teacher') throw new Error('Only the host can start the game.');
      if (rows[0].status !== 'lobby') throw new Error('This game has already started.');

      const questions = await getQuestionList(rows[0].quizId);
      if (!questions.length) throw new Error('The quiz has no questions.');
      const joinedSockets = await io.in(code).fetchSockets();
      if (!joinedSockets.some(item => item.data.userRole === 'student')) {
        throw new Error('At least one student must be connected before starting.');
      }
      const [startResult] = await pool.query(
        "UPDATE game_sessions SET status='active',started_at=CURRENT_TIMESTAMP WHERE id=? AND status='lobby'",
        [rows[0].id]
      );
      if (!startResult.affectedRows) throw new Error('This game has already started.');
      rooms.set(code, {
        sessionId: rows[0].id,
        teacherId: socket.user.id,
        status: 'active',
        questions,
        questionIndex: 0,
        submitted: new Set(),
        timeExpired: false,
        timer: null
      });
      await sendQuestion(code);
    } catch (error) {
      socket.emit('game:error', { error: error.message });
    }
  });

  socket.on('game:next', async ({ roomCode }) => {
    const code = normalizeRoomCode(roomCode);
    if (!code) return socket.emit('game:error', { error: 'Enter a valid six-character room code.' });
    const room = rooms.get(code);
    if (!room || room.status !== 'active' || socket.user.role !== 'teacher' || room.teacherId !== socket.user.id) {
      return socket.emit('game:error', { error: 'Only the host can advance the game.' });
    }
    try {
      const [participantRows] = await pool.query(
        'SELECT COUNT(*) AS participantCount FROM session_participants WHERE session_id=?',
        [room.sessionId]
      );
      if (!room.timeExpired && Date.now() < room.deadlineAt && room.submitted.size < participantRows[0].participantCount) {
        return socket.emit('game:error', { error: 'Wait for every player to answer or for the timer to finish.' });
      }
      room.questionIndex++;
      await sendQuestion(code);
    } catch (error) {
      console.error('Could not advance the game:', error);
      socket.emit('game:error', { error: 'Could not advance the game. Please try again.' });
    }
  });

  socket.on('answer:submit', async ({ roomCode, questionId, choiceId }, callback) => {
    const code = normalizeRoomCode(roomCode);
    if (!code) return callback?.({ ok: false, error: 'Enter a valid six-character room code.' });
    const room = rooms.get(code);
    if (!room || room.status !== 'active') {
      return callback?.({ ok: false, error: 'This game is not accepting answers.' });
    }
    if (socket.user.role !== 'student') {
      return callback?.({ ok: false, error: 'Only students can answer.' });
    }
    if (room.submitted?.has(socket.user.id)) {
      try {
        const [original] = await pool.query(
          'SELECT is_correct AS isCorrect,points_earned AS pointsEarned,choice_id AS choiceId FROM student_answers WHERE session_id=? AND student_id=? AND question_id=?',
          [room.sessionId, socket.user.id, questionId]
        );
        if (original.length) return callback?.({ ok: true, duplicate: true, result: original[0] });
        return callback?.({ ok: false, error: 'Could not find your recorded answer. Please contact your teacher.' });
      } catch (error) {
        console.error('Could not retrieve a previously recorded answer:', error);
        return callback?.({ ok: false, error: 'Could not retrieve your recorded answer. Please try again.' });
      }
    }
    if (Number(questionId) !== room.currentQuestionId) {
      return callback?.({ ok: false, error: 'This question is no longer active.' });
    }
    if (Date.now() > room.deadlineAt || room.timeExpired) {
      return callback?.({ ok: false, error: 'Time is up. This answer was not recorded.' });
    }

    const responseTime = Math.min(room.questions[room.questionIndex].timeLimit * 1000, Date.now() - room.questionStartedAt);
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [sessionRows] = await connection.query(
        "SELECT id,status FROM game_sessions WHERE id=? AND status='active' FOR UPDATE",
        [room.sessionId]
      );
      if (!sessionRows.length) throw new Error('This game is not accepting answers.');
      const [participantRows] = await connection.query(
        'SELECT id FROM session_participants WHERE session_id=? AND student_id=?',
        [room.sessionId, socket.user.id]
      );
      if (!participantRows.length) throw new Error('Join the game before submitting an answer.');
      if (Date.now() > room.deadlineAt || room.timeExpired) throw new Error('Time is up. This answer was not recorded.');

      const [existing] = await connection.query(
        'SELECT is_correct AS isCorrect,points_earned AS pointsEarned,choice_id AS choiceId FROM student_answers WHERE session_id=? AND student_id=? AND question_id=?',
        [room.sessionId, socket.user.id, questionId]
      );
      if (existing.length) {
        await connection.commit();
        room.submitted.add(socket.user.id);
        return callback?.({ ok: true, duplicate: true, result: existing[0] });
      }

      const [choiceRows] = await connection.query(
        'SELECT ac.id,ac.is_correct AS isCorrect FROM answer_choices ac JOIN questions q ON q.id=ac.question_id WHERE ac.id=? AND ac.question_id=?',
        [choiceId, questionId]
      );
      if (!choiceRows.length) throw new Error('Invalid answer choice.');

      const question = room.questions.find(item => item.id === Number(questionId));
      if (!question || Number(questionId) !== room.currentQuestionId) throw new Error('This question is no longer active.');

      const isCorrect = Boolean(choiceRows[0].isCorrect);
      const timeLimitMs = question.timeLimit * 1000;
      const speedRatio = Math.max(0, 1 - responseTime / timeLimitMs);
      const pointsEarned = isCorrect ? 500 + Math.round(500 * speedRatio) : 0;

      await connection.query(
        `INSERT INTO student_answers
         (session_id,student_id,question_id,choice_id,is_correct,points_earned,response_time_ms)
         VALUES (?,?,?,?,?,?,?)`,
        [room.sessionId, socket.user.id, questionId, choiceId, isCorrect, pointsEarned, responseTime]
      );
      await connection.query(
        `INSERT INTO session_scores (session_id,student_id,total_score,correct_answers,total_response_time_ms)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           total_score=total_score+VALUES(total_score),
           correct_answers=correct_answers+VALUES(correct_answers),
           total_response_time_ms=total_response_time_ms+VALUES(total_response_time_ms)`,
        [room.sessionId, socket.user.id, pointsEarned, isCorrect ? 1 : 0, responseTime]
      );
      await connection.commit();
      room.submitted.add(socket.user.id);
      io.to(code).emit('game:progress', {
        questionNumber: room.questionIndex + 1,
        totalQuestions: room.questions.length,
        submittedAnswers: room.submitted.size
      });
      await broadcastLeaderboard(code);
      callback?.({ ok: true, duplicate: false, result: { isCorrect, pointsEarned, choiceId: Number(choiceId) } });
    } catch (error) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error('Could not roll back answer transaction:', rollbackError);
        }
      }
      if (error.code === 'ER_DUP_ENTRY') {
        const [original] = await pool.query(
          'SELECT is_correct AS isCorrect,points_earned AS pointsEarned,choice_id AS choiceId FROM student_answers WHERE session_id=? AND student_id=? AND question_id=?',
          [room.sessionId, socket.user.id, questionId]
        );
        room.submitted.add(socket.user.id);
        return callback?.({ ok: true, duplicate: true, result: original[0] });
      }
      if (error.code) {
        console.error('Could not record a quiz answer:', error);
        callback?.({ ok: false, error: 'Could not record your answer. Please try again.' });
      } else {
        callback?.({ ok: false, error: error.message });
      }
    } finally {
      if (connection) connection.release();
    }
  });

  socket.on('disconnect', async () => {
    const { roomCode, sessionId } = socket.data;
    if (!roomCode || !sessionId) return;
    try {
      const [rows] = await pool.query('SELECT status FROM game_sessions WHERE id=?', [sessionId]);
      if (rows[0]?.status === 'lobby') {
        io.to(roomCode).emit('lobby:participants', {
          participants: await getLobbyParticipants(sessionId, roomCode)
        });
      }
    } catch (error) {
      console.error('Could not refresh the game lobby after disconnect:', error.message);
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query('SELECT 1');
  server.listen(PORT, () => {
    console.log(`QuizArena running at http://localhost:${PORT}`);
  });
}

start().catch(error => {
  console.error('Database connection failed:', error.message);
  console.error('Run "npm run db:setup" after configuring MySQL, then start the app.');
  process.exit(1);
});

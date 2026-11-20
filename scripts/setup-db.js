require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await connection.query(sql);

  const [questionColumns] = await connection.query('SHOW COLUMNS FROM questions LIKE ?', ['is_current']);
  if (!questionColumns.length) {
    await connection.query('ALTER TABLE questions ADD COLUMN is_current BOOLEAN NOT NULL DEFAULT TRUE AFTER position');
  }
  const [questionIndexes] = await connection.query('SHOW INDEX FROM questions');
  if (!questionIndexes.some(index => index.Key_name === 'idx_quiz_current_position')) {
    await connection.query('ALTER TABLE questions ADD INDEX idx_quiz_current_position (quiz_id,is_current,position)');
  }
  if (questionIndexes.some(index => index.Key_name === 'uq_quiz_position')) {
    await connection.query('ALTER TABLE questions DROP INDEX uq_quiz_position');
  }

  const [sessionTitleColumn] = await connection.query('SHOW COLUMNS FROM game_sessions LIKE ?', ['quiz_title']);
  if (!sessionTitleColumn.length) {
    await connection.query('ALTER TABLE game_sessions ADD COLUMN quiz_title VARCHAR(180) NULL AFTER teacher_id');
  }
  await connection.query(
    `UPDATE game_sessions gs JOIN quizzes q ON q.id=gs.quiz_id
     SET gs.quiz_title=q.title WHERE gs.quiz_title IS NULL`
  );
  await connection.query('ALTER TABLE game_sessions MODIFY quiz_title VARCHAR(180) NOT NULL');

  await connection.end();
  console.log('QuizArena MySQL schema created successfully.');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

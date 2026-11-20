# QuizArena

QuizArena is a real-time multiplayer quiz application built with Node.js, Express, Socket.IO, MySQL, HTML, CSS, and JavaScript.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set the MySQL credentials and a strong `JWT_SECRET`.

3. Create the database schema:

   ```bash
   npm run db:setup
   ```

4. To provision an administrator, set `ADMIN_NAME`, `ADMIN_EMAIL`, and a unique `ADMIN_PASSWORD` (at least 12 characters) in `.env`, then run:

   ```bash
   npm run admin:create
   ```

   Admin accounts are intentionally not available through public registration. Remove the bootstrap password from `.env` after account creation.

5. Start the application:

   ```bash
   npm start
   ```

5. Open `http://localhost:3000`.

## Database

The setup script applies `schema.sql`, including foreign keys, indexes, and the unique `session_id + student_id + question_id` constraint that prevents duplicate answer transactions.

Quiz edits create a new current question set and retain prior question and answer rows so completed sessions, answers, and scores remain intact. Game sessions keep the quiz title from when they were created, and games started after an edit load the latest current questions. Run `npm run db:setup` to apply the idempotent question-version and historical-title migration to an existing database.

The admin dashboard is available to provisioned admin accounts and uses live user, quiz, session, and database data.

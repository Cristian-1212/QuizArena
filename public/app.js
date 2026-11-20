const app = document.getElementById('app');
const navActions = document.getElementById('navActions');
const navLinks = document.getElementById('navLinks');
let socket = null;
let socketConnectHandler = null;
let socketDisconnectHandler = null;

function setSocketLifecycleHandlers(onConnect, onDisconnect) {
  if (!socket) return;
  if (socketConnectHandler) socket.off('connect', socketConnectHandler);
  if (socketDisconnectHandler) socket.off('disconnect', socketDisconnectHandler);
  socketConnectHandler = onConnect;
  socketDisconnectHandler = onDisconnect;
  if (onConnect) socket.on('connect', onConnect);
  if (onDisconnect) socket.on('disconnect', onDisconnect);
}

function token() { return localStorage.getItem('quizarena_token'); }
function user() {
  try { return JSON.parse(localStorage.getItem('quizarena_user')); }
  catch { return null; }
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && token()) {
    localStorage.removeItem('quizarena_token');
    localStorage.removeItem('quizarena_user');
    if (socket) socket.disconnect();
    socket = null;
    location.hash = '#/login';
    updateNav();
  }
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[char]);
}

function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3000);
}

function connectSocket() {
  if (!token()) return null;
  if (socket) {
    if (socket.auth?.token !== token()) {
      socket.disconnect();
      socket = null;
    } else {
      if (socket.disconnected) socket.connect();
      return socket;
    }
  }
  socket = io({ auth: { token: token() } });
  socket.on('connect_error', error => toast(error.message));
  return socket;
}

function updateNav() {
  const currentUser = user();
  navLinks.className = 'nav-links';
  if (!currentUser || !token()) {
    navActions.innerHTML = `
      <a class="btn btn-outline" href="#/login">Login</a>
      <a class="btn btn-primary" href="#/register">Register</a>`;
  } else {
    navActions.innerHTML = `
      <a class="btn btn-outline" href="${currentUser.role === 'admin' ? '#/admin' : currentUser.role === 'teacher' ? '#/teacher' : '#/student'}">Dashboard</a>
      <button class="btn" id="logoutButton">Log out</button>`;
    document.getElementById('logoutButton').onclick = () => {
      localStorage.removeItem('quizarena_token');
      localStorage.removeItem('quizarena_user');
      if (socket) socket.disconnect();
      socket = null;
      location.hash = '#/';
      updateNav();
    };
  }
}

function guard(role) {
  const currentUser = user();
  if (!currentUser || !token()) {
    location.hash = '#/login';
    return false;
  }
  if (role && currentUser.role !== role) {
    location.hash = currentUser.role === 'admin' ? '#/admin' : currentUser.role === 'teacher' ? '#/teacher' : '#/student';
    return false;
  }
  return true;
}

function landingPage() {
  app.innerHTML = `
    <div class="container">
      <section class="hero">
        <div>
          <h1>Challenge Your Knowledge. Compete in Real Time.</h1>
          <p>Join interactive quiz competitions, test your knowledge, and compete with classmates through live multiplayer games.</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="#/register">Get Started</a>
            <a class="btn btn-outline" href="#/student">Join a Game</a>
          </div>
        </div>
        <div class="hero-panel">
          <p class="eyebrow">LEARN TOGETHER</p>
          <strong>Play together.</strong>
          <span>Teachers host a room. Students join in seconds and compete live.</span>
          <a class="btn btn-primary" href="#/register">Find your place in the arena <span aria-hidden="true">→</span></a>
        </div>
      </section>
      <section class="section" id="how">
        <h2>How it works</h2>
        <div class="steps">
          <article class="step"><span class="step-number">01</span><h3>Teachers create a quiz</h3><p>Build questions, choices, and time limits in one place.</p></article>
          <article class="step"><span class="step-number">02</span><h3>Students join a room</h3><p>Enter the unique room code from the game lobby.</p></article>
          <article class="step"><span class="step-number">03</span><h3>Compete live</h3><p>Answer quickly and follow the live leaderboard.</p></article>
        </div>
      </section>
      <section class="section" id="about">
        <h2>Built for real classroom competition</h2>
        <div class="features">
          <div class="feature"><strong>Real-Time Multiplayer</strong>Live room-based play.</div>
          <div class="feature"><strong>Instant Score Updates</strong>Server-validated points.</div>
          <div class="feature"><strong>Live Leaderboard</strong>Current rankings after every answer.</div>
          <div class="feature"><strong>Secure Score Recording</strong>Transactional database updates.</div>
        </div>
      </section>
    </div>`;
}

function authPage(mode) {
  const isLogin = mode === 'login';
  app.innerHTML = `
    <div class="auth-layout">
      <aside class="auth-aside">
        <h1>${isLogin ? 'Welcome back.' : 'Ready to compete?'}</h1>
        <p>${isLogin ? 'Continue to your quizzes and live games.' : 'Create a teacher or student account to get started.'}</p>
      </aside>
      <div class="auth-card">
        <h1>${isLogin ? 'Log in' : 'Create account'}</h1>
        <form id="authForm">
          ${isLogin ? '' : `
            <div class="form-group"><label for="name">Full name</label><input class="form-control" id="name" required></div>
            <div class="form-group"><label>Account role</label><div class="role-options">
              <label class="role-option"><input type="radio" name="role" value="student" checked><span>Student</span></label>
              <label class="role-option"><input type="radio" name="role" value="teacher"><span>Teacher</span></label>
            </div></div>`}
          <div class="form-group"><label for="email">Email</label><input class="form-control" id="email" type="email" required></div>
          <div class="form-group"><label for="password">Password</label><input class="form-control" id="password" type="password" minlength="8" required></div>
          <button class="btn btn-primary" type="submit">${isLogin ? 'Log in' : 'Create account'}</button>
        </form>
        <p class="auth-link">${isLogin ? 'New to QuizArena?' : 'Already have an account?'}
          <a href="${isLogin ? '#/register' : '#/login'}">${isLogin ? 'Register' : 'Log in'}</a></p>
      </div>
    </div>`;

  document.getElementById('authForm').onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const body = { email: document.getElementById('email').value, password: document.getElementById('password').value };
      let data;
      if (isLogin) data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
      else data = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ ...body, name: document.getElementById('name').value, role: document.querySelector('input[name="role"]:checked').value })
      });
      localStorage.setItem('quizarena_token', data.token);
      localStorage.setItem('quizarena_user', JSON.stringify(data.user));
      updateNav();
      location.hash = data.user.role === 'admin' ? '#/admin' : data.user.role === 'teacher' ? '#/teacher' : '#/student';
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
}

async function adminDashboard(section = 'overview') {
  if (!guard('admin')) return;
  const views = {
    overview: ['Admin overview', 'At a glance across QuizArena.'],
    users: ['User management', 'Search and review user accounts.'],
    teachers: ['Teachers', 'Teacher accounts and quiz activity.'],
    students: ['Students', 'Student accounts and participation.'],
    reports: ['Reports & analytics', 'Recent sessions and participation.'],
    system: ['System monitoring', 'Live application and database status.']
  };
  const [title, description] = views[section] || views.overview;
  app.innerHTML = `
    <div class="container dashboard">
      <div class="page-heading"><div><p class="eyebrow">QUIZARENA ADMIN</p><h1>${title}</h1><p>${description}</p></div></div>
      <div class="dashboard-grid">
        <aside class="sidebar admin-sidebar">
          <a class="${section === 'overview' ? 'active' : ''}" href="#/admin">Overview</a>
          <a class="${section === 'users' ? 'active' : ''}" href="#/admin/users">User management</a>
          <a class="${section === 'teachers' ? 'active' : ''}" href="#/admin/teachers">Teachers</a>
          <a class="${section === 'students' ? 'active' : ''}" href="#/admin/students">Students</a>
          <a class="${section === 'reports' ? 'active' : ''}" href="#/admin/reports">Reports & analytics</a>
          <a class="${section === 'system' ? 'active' : ''}" href="#/admin/system">System monitoring</a>
        </aside>
        <section class="admin-content" id="adminContent"><div class="loading-state"><span class="spinner"></span> Loading live data...</div></section>
      </div>
    </div>`;

  try {
    const data = await api('/api/admin/overview');
    const summary = data.summary;
    const metrics = `
      <div class="stats stats-four admin-stats">
        <div class="stat"><strong>${summary.totalUsers}</strong><span>Users</span></div>
        <div class="stat"><strong>${summary.teachers}</strong><span>Teachers</span></div>
        <div class="stat"><strong>${summary.students}</strong><span>Students</span></div>
        <div class="stat"><strong>${summary.activeSessions}</strong><span>Active sessions</span></div>
      </div>`;
    const sessionsTable = sessions => sessions.length ? `
      <div class="table-wrap"><table><thead><tr><th>Quiz</th><th>Host</th><th>Players</th><th>Room</th><th>Status</th><th></th></tr></thead><tbody>
      ${sessions.map(session => `<tr><td>${escapeHtml(session.quizTitle)}</td><td>${escapeHtml(session.teacherName)}</td><td>${session.participantCount}</td><td>${escapeHtml(session.roomCode)}</td><td><span class="status-pill status-${escapeHtml(session.status)}">${escapeHtml(session.status)}</span></td><td><a class="btn btn-outline" href="#/results/${session.id}">Results</a></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No sessions have been hosted yet.</div>';
    const content = document.getElementById('adminContent');

    if (section === 'overview') {
      content.innerHTML = `${metrics}
        <div class="card content-card">
          <div class="section-heading"><div><h2>Recent sessions</h2><p>Live activity from the database.</p></div><a href="#/admin/reports">View reports</a></div>
          ${sessionsTable(data.recentSessions)}
        </div>`;
      return;
    }

    if (section === 'users' || section === 'teachers' || section === 'students') {
      const selectedRole = section === 'teachers' ? 'teacher' : section === 'students' ? 'student' : 'all';
      content.innerHTML = `${metrics}
        <div class="card content-card">
          <div class="section-heading"><div><h2>${section === 'users' ? 'Account directory' : `${title} directory`}</h2><p>Up to 100 newest matching accounts.</p></div></div>
          <form id="userSearchForm" class="user-search">
            <label class="sr-only" for="userSearch">Search name or email</label>
            <input id="userSearch" class="form-control" placeholder="Search name or email">
            <label class="sr-only" for="userRole">Filter role</label>
            <select id="userRole" class="form-control" ${selectedRole !== 'all' ? 'disabled' : ''}>
              <option value="all" ${selectedRole === 'all' ? 'selected' : ''}>All roles</option>
              <option value="teacher" ${selectedRole === 'teacher' ? 'selected' : ''}>Teachers</option>
              <option value="student" ${selectedRole === 'student' ? 'selected' : ''}>Students</option>
              <option value="admin">Admins</option>
            </select>
            <button class="btn btn-primary" type="submit">Search</button>
            <button class="btn btn-outline" type="button" id="clearUserSearch">Clear</button>
          </form>
          <div id="userTable"><div class="loading-state"><span class="spinner"></span> Loading users...</div></div>
        </div>`;

      async function loadUsers() {
        const search = document.getElementById('userSearch').value.trim();
        const role = document.getElementById('userRole').value;
        const params = new URLSearchParams({ role, search });
        const usersData = await api(`/api/admin/users?${params}`);
        document.getElementById('userTable').innerHTML = usersData.users.length ? `
          <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Sessions joined</th><th>Joined</th></tr></thead><tbody>
          ${usersData.users.map(account => `<tr><td>${escapeHtml(account.name)}</td><td>${escapeHtml(account.email)}</td><td><span class="role-pill role-${escapeHtml(account.role)}">${escapeHtml(account.role)}</span></td><td>${account.sessionsJoined}</td><td>${new Date(account.createdAt).toLocaleDateString()}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No accounts match your search.</div>';
      }

      document.getElementById('userSearchForm').onsubmit = async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('[type="submit"]');
        button.disabled = true;
        try { await loadUsers(); }
        catch (error) { toast(error.message); }
        finally { button.disabled = false; }
      };
      document.getElementById('clearUserSearch').onclick = () => {
        document.getElementById('userSearch').value = '';
        document.getElementById('userRole').value = selectedRole;
        loadUsers().catch(error => toast(error.message));
      };
      await loadUsers();
      return;
    }

    if (section === 'reports') {
      content.innerHTML = `${metrics}
        <div class="card content-card">
          <div class="section-heading"><div><h2>Session reports</h2><p>Participation and results from recorded sessions.</p></div></div>
          ${sessionsTable(data.recentSessions)}
        </div>`;
      return;
    }

    content.innerHTML = `${metrics}
      <div class="system-grid">
        <div class="card system-card"><span class="system-indicator"></span><div><h2>Database</h2><p>Connection verified for this request.</p><strong class="status-good">${escapeHtml(data.system.database)}</strong></div></div>
        <div class="card system-card"><span class="system-indicator"></span><div><h2>Application</h2><p>Process uptime</p><strong>${Math.floor(data.system.uptimeSeconds / 60)} min</strong></div></div>
        <div class="card system-card"><span class="system-indicator"></span><div><h2>Activity</h2><p>Game sessions recorded</p><strong>${summary.totalSessions}</strong></div></div>
      </div>
      <button class="btn btn-outline refresh-status" id="refreshSystem">Refresh status</button>`;
    document.getElementById('refreshSystem').onclick = () => adminDashboard('system');
  } catch (error) {
    const content = document.getElementById('adminContent');
    if (content) content.innerHTML = `<div class="card content-card error-panel"><h2>Could not load admin data</h2><p>${escapeHtml(error.message)}</p><button class="btn btn-outline" id="retryAdmin">Try again</button></div>`;
    document.getElementById('retryAdmin')?.addEventListener('click', () => adminDashboard(section));
  }
}

async function teacherDashboard() {
  if (!guard('teacher')) return;
  app.innerHTML = `
    <div class="container dashboard">
      <div class="page-heading"><div><h1>Teacher dashboard</h1><p>${escapeHtml(user().name)}</p></div>
        <a class="btn btn-primary" href="#/quiz/new">Create quiz</a></div>
      <div class="dashboard-grid">
        <aside class="sidebar">
          <a class="active" href="#/teacher">Dashboard overview</a>
          <a href="#/quizzes">My quizzes</a>
          <a href="#/host">Host a game</a>
          <a href="#/sessions">Game sessions</a>
        </aside>
        <section>
          <div id="dashboardStats" class="stats stats-four"><div class="stat"><strong>—</strong><span>My quizzes</span></div><div class="stat"><strong>—</strong><span>Active sessions</span></div><div class="stat"><strong>—</strong><span>Participants</span></div></div>
          <div class="card content-card">
            <div class="section-heading"><div><h2>Recent quizzes</h2><p>Keep your classroom moving.</p></div><a href="#/quizzes">View all</a></div>
            <div id="recentTeacherQuizzes"></div>
            <div class="teacher-analytics"><h3>Participation by quiz</h3><div id="teacherChart"></div></div>
          </div>
        </section>
      </div>
    </div>`;
  try {
    const data = await api('/api/teacher/overview');
    document.getElementById('dashboardStats').innerHTML = `
      <div class="stat"><strong>${data.summary.totalQuizzes}</strong><span>My quizzes</span></div>
      <div class="stat"><strong>${data.summary.activeSessions}</strong><span>Active sessions</span></div>
      <div class="stat"><strong>${data.summary.totalParticipants}</strong><span>Player joins</span></div>`;
    document.getElementById('recentTeacherQuizzes').innerHTML = data.recentQuizzes.length
      ? `<div class="table-wrap"><table><thead><tr><th>Quiz</th><th>Players</th><th>Games</th><th>Status</th></tr></thead><tbody>
        ${data.recentQuizzes.map(quiz => `<tr><td><a href="#/quiz/${quiz.id}">${escapeHtml(quiz.title)}</a></td><td>${quiz.participantCount}</td><td>${quiz.sessionCount}</td><td>${quiz.isPublished ? 'Published' : 'Draft'}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<div class="empty">Create your first quiz to see classroom activity here.</div>';
    const maxParticipants = Math.max(1, ...data.recentQuizzes.map(quiz => Number(quiz.participantCount)));
    document.getElementById('teacherChart').innerHTML = data.recentQuizzes.length
      ? data.recentQuizzes.map(quiz => `
        <div class="chart-row"><span title="${escapeHtml(quiz.title)}">${escapeHtml(quiz.title)}</span>
          <div class="chart-track"><span style="width:${Math.round(Number(quiz.participantCount) / maxParticipants * 100)}%"></span></div>
          <strong>${quiz.participantCount}</strong></div>`).join('')
      : '<p class="muted-copy">Your quiz participation will appear here.</p>';
  } catch (error) { toast(error.message); }
}

async function quizListPage() {
  if (!guard('teacher')) return;
  app.innerHTML = `<div class="container dashboard"><div class="page-heading"><div><h1>My quizzes</h1><p>Create and manage quiz content.</p></div><a class="btn btn-primary" href="#/quiz/new">Create quiz</a></div><div class="card content-card"><div id="quizTable"></div></div></div>`;
  try {
    const data = await api('/api/quizzes');
    document.getElementById('quizTable').innerHTML = data.quizzes.length ? `
      <div class="table-wrap"><table><thead><tr><th>Title</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>
      ${data.quizzes.map(quiz => `<tr><td>${escapeHtml(quiz.title)}</td><td>${quiz.isPublished ? 'Published' : 'Draft'}</td><td>${new Date(quiz.createdAt).toLocaleDateString()}</td><td class="table-actions"><a class="btn" href="#/quiz/${quiz.id}">Edit</a>${quiz.isPublished ? `<button class="btn btn-outline" data-unpublish="${quiz.id}">Unpublish</button>` : `<button class="btn btn-outline" data-publish="${quiz.id}">Publish</button><button class="btn btn-danger" data-delete-quiz="${quiz.id}">Delete</button>`}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No quizzes yet.</div>';
    document.querySelectorAll('[data-publish]').forEach(button => button.onclick = async () => {
      if (!confirm('Publish this quiz? You must unpublish it before editing or deleting.')) return;
      button.disabled = true;
      try {
        await api(`/api/quizzes/${button.dataset.publish}/publish`, { method: 'POST' });
        toast('Quiz published.');
        quizListPage();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
    document.querySelectorAll('[data-unpublish]').forEach(button => button.onclick = async () => {
      if (!confirm('Unpublish this quiz?')) return;
      button.disabled = true;
      try {
        await api(`/api/quizzes/${button.dataset.unpublish}/unpublish`, { method: 'POST' });
        toast('Quiz unpublished.');
        quizListPage();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
    document.querySelectorAll('[data-delete-quiz]').forEach(button => button.onclick = async () => {
      if (!confirm('Delete this quiz? This cannot be undone.')) return;
      button.disabled = true;
      try {
        await api(`/api/quizzes/${button.dataset.deleteQuiz}`, { method: 'DELETE' });
        toast('Quiz deleted.');
        quizListPage();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
  } catch (error) { toast(error.message); }
}

async function quizBuilderPage(id) {
  if (!guard('teacher')) return;
  let quiz = { title: '', description: '' };
  let questions = [{ text: '', timeLimit: 20, choices: [{ text: '' }, { text: '' }, { text: '' }, { text: '' }], correctIndex: 0 }];
  if (id) {
    try {
      const data = await api(`/api/quizzes/${id}`);
      quiz = data.quiz;
      questions = data.questions.map(q => ({
        text: q.text,
        timeLimit: q.timeLimit,
        correctIndex: q.choices.findIndex(choice => choice.isCorrect),
        choices: q.choices.map(choice => ({ text: choice.text }))
      }));
    } catch (error) { toast(error.message); }
  }
  app.innerHTML = `
    <div class="container dashboard quiz-builder">
      <div class="page-heading"><div><h1>${id ? 'Edit quiz' : 'Create quiz'}</h1><p>Configure questions and answer choices.</p></div></div>
      <div class="card content-card">
        <form id="quizForm">
          <div class="form-group"><label>Quiz title</label><input class="form-control" id="quizTitle" value="${escapeHtml(quiz.title)}" required></div>
          <div class="form-group"><label>Description</label><textarea class="form-control" id="quizDescription">${escapeHtml(quiz.description || '')}</textarea></div>
          <div id="questionEditors"></div>
          <div class="builder-actions"><button class="btn btn-outline" type="button" id="addQuestion">Add question</button><button class="btn btn-outline" type="button" id="previewQuiz">Preview</button><button class="btn btn-primary" type="submit">${id ? 'Save changes' : 'Save quiz'}</button></div>
        </form>
      </div>
      <dialog class="preview-dialog" id="quizPreview">
        <form method="dialog"><button class="btn btn-outline dialog-close" aria-label="Close preview">Close</button></form>
        <div id="previewContent"></div>
      </dialog>
      <dialog class="preview-dialog" id="historyEditConfirm">
        <p>You are editing a quiz with existing game history. Your changes will apply to future game sessions. Previous game records and results will remain unchanged.</p>
        <div class="builder-actions">
          <button class="btn btn-outline" type="button" id="cancelHistoryEdit">Cancel</button>
          <button class="btn btn-primary" type="button" id="confirmHistoryEdit">Save Changes</button>
        </div>
      </dialog>
    </div>`;

  function renderQuestions() {
    const editor = document.getElementById('questionEditors');
    editor.innerHTML = questions.map((question, questionIndex) => `
      <div class="question-editor" data-index="${questionIndex}">
        <div class="question-editor-header"><strong>Question ${questionIndex + 1}</strong>
          ${questions.length > 1 ? `<button type="button" class="btn btn-danger remove-question">Delete</button>` : ''}
        </div>
        <div class="form-group"><label>Question</label><input class="form-control question-text" value="${escapeHtml(question.text)}" required></div>
        <div class="form-group"><label>Time limit (seconds)</label><input class="form-control time-limit" type="number" min="5" max="120" value="${question.timeLimit}"></div>
        ${question.choices.map((choice, choiceIndex) => `
          <div class="choice-row">
            <input type="radio" name="correct-${questionIndex}" ${question.correctIndex === choiceIndex ? 'checked' : ''} aria-label="Mark choice ${choiceIndex + 1} correct">
            <input class="form-control choice-text" value="${escapeHtml(choice.text)}" required aria-label="Choice ${choiceIndex + 1}">
          </div>`).join('')}
      </div>`).join('');
  }
  renderQuestions();

  document.getElementById('addQuestion').onclick = () => {
    collectQuestionEdits();
    questions.push({ text: '', timeLimit: 20, choices: [{ text: '' }, { text: '' }, { text: '' }, { text: '' }], correctIndex: 0 });
    renderQuestions();
  };

  function collectQuestionEdits() {
    document.querySelectorAll('.question-editor').forEach((editor, index) => {
      questions[index].text = editor.querySelector('.question-text').value;
      questions[index].timeLimit = Number(editor.querySelector('.time-limit').value);
      questions[index].choices = [...editor.querySelectorAll('.choice-text')].map(input => ({ text: input.value }));
      questions[index].correctIndex = [...editor.querySelectorAll('input[type="radio"]')].findIndex(input => input.checked);
    });
  }

  document.getElementById('questionEditors').addEventListener('click', event => {
    if (!event.target.classList.contains('remove-question')) return;
    collectQuestionEdits();
    const index = Number(event.target.closest('.question-editor').dataset.index);
    questions.splice(index, 1);
    renderQuestions();
  });

  document.getElementById('previewQuiz').onclick = () => {
    collectQuestionEdits();
    const preview = document.getElementById('previewContent');
    preview.innerHTML = `
      <p class="eyebrow">QUIZ PREVIEW</p><h2>${escapeHtml(document.getElementById('quizTitle').value || 'Untitled quiz')}</h2>
      ${questions.map((question, index) => `
        <article class="preview-question"><span class="step-number">QUESTION ${index + 1}</span><h3>${escapeHtml(question.text || 'Add a question')}</h3>
          <div class="preview-choices">${question.choices.map((choice, choiceIndex) =>
            `<div class="preview-choice ${choiceIndex === question.correctIndex ? 'preview-correct' : ''}"><span>${String.fromCharCode(65 + choiceIndex)}</span>${escapeHtml(choice.text || 'Answer choice')}</div>`
          ).join('')}</div>
          <small>${question.timeLimit} seconds</small>
        </article>`).join('')}`;
    document.getElementById('quizPreview').showModal();
  };

  async function saveQuizChanges(button) {
    button.disabled = true;
    try {
      const payload = { title: document.getElementById('quizTitle').value, description: document.getElementById('quizDescription').value, questions };
      if (id) await api(`/api/quizzes/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/quizzes', { method: 'POST', body: JSON.stringify(payload) });
      toast('Quiz saved.');
      location.hash = '#/quizzes';
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  }

  document.getElementById('cancelHistoryEdit').onclick = () => {
    document.getElementById('historyEditConfirm').close();
  };
  document.getElementById('confirmHistoryEdit').onclick = async event => {
    document.getElementById('historyEditConfirm').close();
    await saveQuizChanges(event.currentTarget);
  };

  document.getElementById('quizForm').onsubmit = event => {
    event.preventDefault();
    collectQuestionEdits();
    const invalidQuestion = questions.find(question =>
      !question.text.trim() ||
      question.choices.length !== 4 ||
      question.choices.some(choice => !choice.text.trim()) ||
      !Number.isInteger(question.correctIndex) ||
      question.correctIndex < 0 ||
      question.correctIndex > 3 ||
      !Number.isInteger(question.timeLimit) ||
      question.timeLimit < 5 ||
      question.timeLimit > 120
    );
    if (invalidQuestion) {
      toast('Each question needs text, four choices, a correct answer, and a 5–120 second time limit.');
      return;
    }
    if (id && quiz.hasGameHistory) {
      document.getElementById('historyEditConfirm').showModal();
      return;
    }
    saveQuizChanges(event.currentTarget.querySelector('[type="submit"]'));
  };
}

async function hostPage() {
  if (!guard('teacher')) return;
  app.innerHTML = `<div class="container dashboard"><div class="page-heading"><div><h1>Host a game</h1><p>Choose a published or saved quiz to start.</p></div></div><div class="card content-card"><div id="hostContent"></div></div></div>`;
  try {
    const data = await api('/api/quizzes');
    document.getElementById('hostContent').innerHTML = data.quizzes.length ? `
      <div class="form-group"><label for="quizSelect">Quiz</label><select class="form-control" id="quizSelect">${data.quizzes.map(q => `<option value="${q.id}">${escapeHtml(q.title)}</option>`).join('')}</select></div>
      <button class="btn btn-primary" id="createSession">Create game session</button>` : '<div class="empty">Create a quiz before hosting a game. <a href="#/quiz/new">Create a quiz</a></div>';
    const createButton = document.getElementById('createSession');
    if (createButton) createButton.onclick = async () => {
      createButton.disabled = true;
      try {
        const session = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ quizId: Number(document.getElementById('quizSelect').value) }) });
        location.hash = `#/lobby/${session.roomCode}`;
      } catch (error) { toast(error.message); }
      finally { createButton.disabled = false; }
    };
  } catch (error) { toast(error.message); }
}

async function sessionsPage() {
  if (!guard('teacher')) return;
  app.innerHTML = `<div class="container dashboard"><div class="page-heading"><div><h1>Game sessions</h1><p>Recent rooms and final results.</p></div></div><div class="card content-card" id="sessionsTable"></div></div>`;
  try {
    const data = await api('/api/sessions');
    document.getElementById('sessionsTable').innerHTML = data.sessions.length ? `
      <div class="table-wrap"><table><thead><tr><th>Quiz</th><th>Room</th><th>Status</th><th></th></tr></thead><tbody>
      ${data.sessions.map(session => `<tr><td>${escapeHtml(session.title)}</td><td>${escapeHtml(session.roomCode)}</td><td>${escapeHtml(session.status)}</td><td>${session.status === 'lobby' ? `<a class="btn" href="#/lobby/${session.roomCode}">Open lobby</a>` : `<button class="btn" data-results="${session.id}">Results</button>`}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No game sessions yet.</div>';
    document.querySelectorAll('[data-results]').forEach(button => button.onclick = () => location.hash = `#/results/${button.dataset.results}`);
  } catch (error) { toast(error.message); }
}

async function studentDashboard() {
  if (!guard('student')) return;
  app.innerHTML = `
    <div class="container dashboard">
      <div class="page-heading"><div><p class="eyebrow">YOUR LEARNING ARENA</p><h1>Welcome back, ${escapeHtml(user().name.split(' ')[0])}!</h1><p>Your next personal best is one quiz away.</p></div></div>
      <div class="join-card">
        <div><p class="eyebrow">GOT A ROOM CODE?</p><h2>Jump into a live quiz</h2><p>Enter the code shared by your teacher to join the game.</p></div>
        <div class="join-panel">
          <input class="form-control room-code-input" id="roomCodeInput" maxlength="6" placeholder="ABC123" aria-label="Room code" autocomplete="off">
          <button class="btn btn-primary" id="joinRoomButton"><span>Join quiz</span><span aria-hidden="true">→</span></button>
        </div>
      </div>
      <section class="stats stats-four student-stats" id="studentStats" aria-live="polite">
        <div class="stat"><strong>—</strong><span>Total points</span></div>
        <div class="stat"><strong>—</strong><span>Quizzes played</span></div>
        <div class="stat"><strong>—</strong><span>Accuracy</span></div>
        <div class="stat"><strong>—</strong><span>Class ranking</span></div>
      </section>
      <div class="student-dashboard-grid">
        <section class="card content-card"><div class="section-heading"><div><h2>Recent games</h2><p>Your latest quiz results.</p></div></div><div id="historyTable"></div></section>
        <aside class="card content-card"><div class="section-heading"><div><h2>Achievements</h2><p>Earned through play.</p></div></div><div id="achievementList" class="achievement-list"></div></aside>
      </div>
    </div>`;

  const joinButton = document.getElementById('joinRoomButton');
  joinButton.onclick = () => {
    const code = document.getElementById('roomCodeInput').value.trim().toUpperCase();
    if (!/^[A-F0-9]{6}$/.test(code)) {
      toast('Enter the six-character room code shared by your teacher.');
      return;
    }
    joinButton.disabled = true;
    joinButton.innerHTML = '<span class="spinner"></span><span>Joining...</span>';
    location.hash = `#/play/${code}`;
  };
  document.getElementById('roomCodeInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') document.getElementById('joinRoomButton').click();
  });

  try {
    const data = await api('/api/student/overview');
    const history = data.history;
    const summary = data.summary;
    document.getElementById('studentStats').innerHTML = `
      <div class="stat"><strong>${Number(summary.totalPoints).toLocaleString()}</strong><span>Total points</span></div>
      <div class="stat"><strong>${summary.gamesPlayed}</strong><span>Quizzes played</span></div>
      <div class="stat"><strong>${summary.accuracy}%</strong><span>Answer accuracy</span></div>
      <div class="stat"><strong>${summary.currentRank ? `#${summary.currentRank}` : '—'}</strong><span>Class ranking</span></div>`;
    document.getElementById('historyTable').innerHTML = history.length ? `
      <div class="table-wrap"><table><thead><tr><th>Quiz</th><th>Points</th><th>Correct</th><th>Status</th><th></th></tr></thead><tbody>
      ${history.map(item => `<tr><td>${escapeHtml(item.title)}</td><td>${Number(item.totalScore).toLocaleString()}</td><td>${item.correctAnswers}</td><td><span class="status-pill status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td><td>${item.status === 'finished' ? `<a class="btn btn-outline" href="#/results/${item.id}">Results</a>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">You have not joined any games yet.</div>';
    const badges = [
      { earned: Number(summary.gamesPlayed) >= 1, title: 'First finish', description: 'Finish your first quiz', icon: '✦' },
      { earned: Number(summary.correctAnswers) >= 10, title: 'Knowledge builder', description: 'Answer 10 questions correctly', icon: '◆' },
      { earned: Number(summary.gamesPlayed) >= 5, title: 'Quiz regular', description: 'Finish five quizzes', icon: '★' },
      { earned: Number(summary.totalAnswers) >= 5 && Number(summary.accuracy) >= 80, title: 'Sharp thinker', description: 'Reach 80% accuracy after five answers', icon: '●' }
    ];
    document.getElementById('achievementList').innerHTML = badges.map(badge => `
      <div class="achievement ${badge.earned ? 'earned' : 'locked'}">
        <span class="achievement-icon">${badge.icon}</span>
        <span><strong>${badge.title}</strong><small>${badge.description}</small></span>
        <span class="achievement-state">${badge.earned ? 'Earned' : 'Locked'}</span>
      </div>`).join('');
  } catch (error) { toast(error.message); }
}

function lobbyPage(roomCode) {
  const currentUser = user();
  if (!guard()) return;
  app.innerHTML = `
    <div class="container lobby">
      <div class="lobby-heading"><p class="eyebrow">MULTIPLAYER LOBBY</p><h1 id="lobbyQuizTitle">Getting your game ready...</h1><p>Hosted by <strong id="lobbyHostName">your teacher</strong></p></div>
      <div class="lobby-grid">
        <div class="card room-code"><small>Share this room code</small><strong>${escapeHtml(roomCode)}</strong>
          <div class="connection-state"><span class="connection-dot" id="connectionDot"></span><span id="connectionStatus">Connecting...</span></div>
          <p id="lobbyStatus">${currentUser.role === 'teacher' ? 'Your players will appear here as they join.' : 'Joining game lobby...'}</p>
          ${currentUser.role === 'teacher' ? '<button class="btn btn-primary" id="startGameButton" disabled>Start game</button>' : ''}
        </div>
        <aside class="card content-card"><div class="section-heading"><div><h2>Players in the room</h2><p><strong id="participantCount">0</strong> joined</p></div><span class="live-pill">● LIVE</span></div><ul class="participant-list" id="participantList"><li class="empty">Waiting for players...</li></ul></aside>
      </div>
    </div>`;

  const liveSocket = connectSocket();
  if (!liveSocket) {
    location.hash = '#/login';
    return;
  }
  liveSocket.off('lobby:participants');
  liveSocket.off('game:question');
  liveSocket.off('game:finished');

  function renderParticipants(participants, details = {}) {
    const list = document.getElementById('participantList');
    if (!list) return;
    document.getElementById('participantCount').textContent = participants.length;
    if (details.quizTitle) document.getElementById('lobbyQuizTitle').textContent = details.quizTitle;
    if (details.teacherName) document.getElementById('lobbyHostName').textContent = details.teacherName;
    list.innerHTML = participants.length ? participants.map(person =>
      `<li><span class="avatar">${escapeHtml(person.name.charAt(0).toUpperCase())}</span><span>${escapeHtml(person.name)}</span><span class="player-status ${person.connected ? '' : 'player-offline'}">${person.connected ? 'Online' : 'Offline'}</span></li>`
    ).join('') : '<li class="empty">Waiting for players...</li>';
    const startButton = document.getElementById('startGameButton');
    if (startButton) startButton.disabled = !participants.some(person => person.connected);
  }

  function setConnectionState(connected) {
    const dot = document.getElementById('connectionDot');
    const label = document.getElementById('connectionStatus');
    if (!dot || !label) return;
    dot.classList.toggle('offline', !connected);
    label.textContent = connected ? 'Connected to game' : 'Reconnecting...';
  }

  setConnectionState(liveSocket.connected);
  liveSocket.on('lobby:participants', data => {
    renderParticipants(data.participants, data);
  });
  liveSocket.on('game:question', () => {
    location.hash = `#/game/${roomCode}`;
  });
  liveSocket.on('game:finished', data => {
    location.hash = `#/game/${roomCode}`;
  });

  function joinLobby() {
    setConnectionState(true);
    if (currentUser.role === 'teacher') {
      liveSocket.emit('teacher:join_lobby', { roomCode }, response => {
        if (!response?.ok) return toast(response?.error || 'Could not open lobby.');
        renderParticipants(response.participants, response);
        if (response.status === 'active') location.hash = `#/game/${roomCode}`;
        else if (response.status === 'finished') location.hash = `#/results/${response.sessionId}`;
      });
      return;
    }

    liveSocket.emit('game:join', { roomCode }, response => {
      if (!response?.ok) {
        toast(response?.error || 'Could not join this game.');
        setTimeout(() => location.hash = '#/student', 800);
      } else {
        renderParticipants(response.participants, response);
        document.getElementById('lobbyStatus').textContent = response.status === 'active'
          ? 'The quiz is already in progress. Joining now...'
          : 'You are in. Waiting for the teacher to start.';
        if (response.status === 'active') location.hash = `#/game/${roomCode}`;
        else if (response.status === 'finished') location.hash = `#/results/${response.sessionId}`;
      }
    });
  }
  setSocketLifecycleHandlers(joinLobby, () => setConnectionState(false));
  if (liveSocket.connected) joinLobby();
  if (currentUser.role === 'teacher') {
    document.getElementById('startGameButton').onclick = () => {
      document.getElementById('startGameButton').disabled = true;
      liveSocket.emit('game:start', { roomCode });
    };
  }
}

function playPage(roomCode) {
  lobbyPage(roomCode);
}

function gamePage(roomCode) {
  if (!guard()) return;
  const currentUser = user();
  app.innerHTML = `
    <div class="game-layout">
      <section class="game-main">
        <div class="game-topline"><span id="questionProgress">Waiting for question</span><span>ROOM ${escapeHtml(roomCode)}</span></div>
        <div id="questionArea"><div class="question-text">The game is starting...</div></div>
      </section>
      <aside class="game-side">
        <div class="section-heading"><div><p class="eyebrow">LIVE RANKINGS</p><h2>Leaderboard</h2></div><span class="live-pill">● LIVE</span></div>
        <div id="leaderboardPodium"></div>
        <ul class="leaderboard" id="leaderboard"><li class="empty">Waiting for scores</li></ul>
        ${currentUser.role === 'teacher' ? '<div class="teacher-game-controls"><div id="submittedCount" class="stat"><strong>0</strong><span>Submitted answers</span></div><button class="btn btn-primary" id="nextQuestionButton">Next question <span aria-hidden="true">→</span></button></div>' : ''}
      </aside>
    </div>`;

  const liveSocket = connectSocket();
  liveSocket.off('game:question');
  liveSocket.off('game:progress');
  liveSocket.off('leaderboard:update');
  liveSocket.off('question:timeup');
  liveSocket.off('game:finished');
  liveSocket.off('game:error');

  let timerInterval = null;
  let activeQuestion = null;
  let submitted = false;

  liveSocket.on('game:error', data => toast(data.error));
  liveSocket.on('game:progress', data => {
    const progress = document.getElementById('questionProgress');
    if (progress) progress.innerHTML = `Question ${data.questionNumber} of ${data.totalQuestions}<span class="progress-track"><span style="width:${Math.round(data.questionNumber / data.totalQuestions * 100)}%"></span></span>`;
    const count = document.getElementById('submittedCount');
    if (count) count.innerHTML = `<strong>${data.submittedAnswers}</strong><span>Submitted answers</span>`;
  });
  liveSocket.on('leaderboard:update', data => renderLeaderboard(data.leaderboard));
  liveSocket.on('game:finished', data => renderFinal(data.leaderboard));
  liveSocket.on('question:timeup', data => {
    if (!activeQuestion || activeQuestion.id !== data.questionId) return;
    document.querySelectorAll('.answer').forEach(button => button.disabled = true);
    const status = document.getElementById('answerStatus');
    if (status && !submitted) status.textContent = 'Time is up. Wait for the next question.';
  });

  function renderQuestion(question) {
    if (!question) return;
    activeQuestion = question;
    submitted = false;
    const progress = document.getElementById('questionProgress');
    if (progress) progress.innerHTML = `Question ${question.position} of ${question.total}<span class="progress-track"><span style="width:${Math.round(question.position / question.total * 100)}%"></span></span>`;
    const area = document.getElementById('questionArea');
    if (!area) return;
    area.innerHTML = `
      <div class="question-intro"><span class="eyebrow">QUESTION ${question.position} / ${question.total}</span><div class="timer" id="timer">${question.timeLimit}</div></div>
      <h1 class="question-text question-enter">${escapeHtml(question.text)}</h1>
      ${currentUser.role === 'student' ? `<div class="answers">${question.choices.map((choice, index) => `
        <button class="answer" data-choice="${choice.id}"><span class="answer-letter">${String.fromCharCode(65 + index)}</span><span>${escapeHtml(choice.text)}</span><span class="answer-mark"></span></button>
      `).join('')}</div><div id="answerStatus" class="answer-status" role="status" aria-live="polite"></div>` : '<div class="answering-note"><span class="spinner"></span> Players are answering this question</div>'}`;
    clearInterval(timerInterval);
    const remainingAtStart = question.remainingMs == null ? question.timeLimit * 1000 : question.remainingMs;
    const started = Date.now();
    timerInterval = setInterval(() => {
      const remainingMs = Math.max(0, remainingAtStart - (Date.now() - started));
      const remaining = Math.ceil(remainingMs / 1000);
      const timer = document.getElementById('timer');
      if (timer) {
        timer.textContent = remaining;
        timer.classList.toggle('timer-warning', remaining <= 5);
      }
      if (remaining === 0) {
        clearInterval(timerInterval);
        document.querySelectorAll('.answer').forEach(button => button.disabled = true);
      }
    }, 100);

    if (currentUser.role === 'student') {
      document.querySelectorAll('.answer').forEach(button => {
        button.onclick = () => {
          if (submitted) return;
          submitted = true;
          button.classList.add('selected');
          document.querySelectorAll('.answer').forEach(answer => answer.disabled = true);
          const status = document.getElementById('answerStatus');
          if (status) status.innerHTML = '<span class="spinner"></span> Submitting your answer...';
          liveSocket.emit('answer:submit', {
            roomCode,
            questionId: question.id,
            choiceId: Number(button.dataset.choice)
          }, response => {
            if (!response?.ok) {
              if (status) {
                status.textContent = response?.error || 'Answer could not be submitted.';
                status.classList.add('status-error');
              }
              submitted = false;
              if (Date.now() <= started + remainingAtStart) {
                document.querySelectorAll('.answer').forEach(answer => answer.disabled = false);
                button.classList.remove('selected');
              }
              return;
            }
            const result = response.result || {};
            const recordedChoice = document.querySelector(`[data-choice="${Number(result.choiceId || button.dataset.choice)}"]`);
            if (recordedChoice) {
              recordedChoice.classList.remove('selected');
              recordedChoice.classList.add(result.isCorrect ? 'answer-correct' : 'answer-incorrect');
            }
            if (status) {
              status.textContent = response.duplicate
                ? `Your answer is already recorded · ${result.pointsEarned || 0} points`
                : `${result.isCorrect ? 'Correct answer' : 'Not quite'} · ${result.pointsEarned || 0} points`;
              status.classList.toggle('status-success', Boolean(result.isCorrect));
              status.classList.toggle('status-error', !result.isCorrect);
            }
          });
        };
      });
    }
  }

  liveSocket.on('game:question', renderQuestion);

  function joinGame() {
    if (currentUser.role === 'teacher') {
      liveSocket.emit('teacher:join_lobby', { roomCode }, response => {
        if (!response?.ok) toast(response?.error || 'Could not monitor this game.');
        else if (response.status === 'finished') renderFinal(response.leaderboard);
        else if (response.liveState) {
          renderQuestion(response.liveState.question);
          renderLeaderboard(response.leaderboard);
          const count = document.getElementById('submittedCount');
          if (count) count.innerHTML = `<strong>${response.liveState.submittedAnswers}</strong><span>Submitted answers</span>`;
        } else if (response.status === 'lobby') location.hash = `#/lobby/${roomCode}`;
        else toast('The game is active, but its live state is unavailable. Restart the server before hosting a new session.');
      });
    } else {
      liveSocket.emit('game:join', { roomCode }, response => {
        if (!response?.ok) toast(response?.error || 'Could not resume game.');
        else if (response.status === 'lobby') location.hash = `#/lobby/${roomCode}`;
        else if (response.status === 'finished') renderFinal(response.leaderboard);
        else if (response.liveState) {
          renderQuestion(response.liveState.question);
          renderLeaderboard(response.leaderboard);
        } else toast('The game is active, but its live state is unavailable. Ask your teacher for help.');
      });
    }
  }
  setSocketLifecycleHandlers(joinGame);
  if (liveSocket.connected) joinGame();

  if (currentUser.role === 'teacher') {
    const nextButton = document.getElementById('nextQuestionButton');
    if (nextButton) nextButton.onclick = () => liveSocket.emit('game:next', { roomCode });
  }

  function renderLeaderboard(entries) {
    const list = document.getElementById('leaderboard');
    if (!list) return;
    const podium = document.getElementById('leaderboardPodium');
    const topThree = entries.slice(0, 3);
    if (podium) podium.innerHTML = topThree.length ? `<div class="podium">${topThree.map(player => `
      <div class="podium-player podium-${player.rank}">
        <span class="podium-medal">${player.rank === 1 ? '♛' : player.rank}</span>
        <strong>${escapeHtml(player.name)}</strong><span>${Number(player.totalScore).toLocaleString()} pts</span>
      </div>`).join('')}</div>` : '';
    list.innerHTML = entries.length > 3 ? entries.slice(3).map(player => `
      <li><span class="rank">${player.rank}</span><span>${escapeHtml(player.name)}<small class="player-answer-count">${player.correctAnswers} correct · ${player.incorrectAnswers || 0} missed</small></span><strong>${Number(player.totalScore).toLocaleString()}</strong></li>
    `).join('') : entries.length ? '' : '<li class="empty">Waiting for scores</li>';
  }

  function renderFinal(entries) {
    clearInterval(timerInterval);
    app.innerHTML = `
      <div class="container final-screen">
        <p class="eyebrow">GAME COMPLETE</p><h1>That’s a wrap!</h1>
        <p class="final-subtitle">Here’s how everyone did.</p>
        ${entries.length ? `<div class="podium podium-final">${entries.slice(0, 3).map(player => `
          <div class="podium-player podium-${player.rank}"><span class="podium-medal">${player.rank === 1 ? '♛' : player.rank}</span><strong>${escapeHtml(player.name)}</strong><span>${Number(player.totalScore).toLocaleString()} pts</span><small>${player.correctAnswers} correct · ${player.incorrectAnswers || 0} missed</small></div>
        `).join('')}</div>` : '<div class="empty">No scores were recorded in this game.</div>'}
        <ul class="leaderboard final-leaderboard">${entries.slice(3).map(player =>
          `<li><span class="rank">${player.rank}</span><span>${escapeHtml(player.name)}<small class="player-answer-count">${player.correctAnswers} correct · ${player.incorrectAnswers || 0} missed</small></span><strong>${Number(player.totalScore).toLocaleString()} pts</strong></li>`
        ).join('')}</ul>
        <a class="btn btn-primary" href="${currentUser.role === 'teacher' ? '#/sessions' : '#/student'}">Back to dashboard</a>
      </div>`;
  }
}

async function resultsPage(sessionId) {
  if (!guard()) return;
  const homeRoute = user().role === 'admin' ? 'admin' : user().role === 'teacher' ? 'sessions' : 'student';
  app.innerHTML = `<div class="container final-screen"><p class="eyebrow">GAME RESULTS</p><h1>Session leaderboard</h1><div id="resultsPodium"></div><ul class="leaderboard final-leaderboard" id="resultsLeaderboard"></ul><a class="btn btn-outline" href="#/${homeRoute}">Back to dashboard</a></div>`;
  try {
    const data = await api(`/api/sessions/${sessionId}/results`);
    document.getElementById('resultsPodium').innerHTML = data.leaderboard.length
      ? `<div class="podium podium-final">${data.leaderboard.slice(0, 3).map(player => `
        <div class="podium-player podium-${player.rank}"><span class="podium-medal">${player.rank === 1 ? '♛' : player.rank}</span><strong>${escapeHtml(player.name)}</strong><span>${Number(player.totalScore).toLocaleString()} pts</span><small>${player.correctAnswers} correct · ${player.incorrectAnswers || 0} missed</small></div>
      `).join('')}</div>`
      : '<div class="empty">No scores were recorded in this game.</div>';
    document.getElementById('resultsLeaderboard').innerHTML = data.leaderboard.slice(3).map(player =>
      `<li><span class="rank">${player.rank}</span><span>${escapeHtml(player.name)}<small class="player-answer-count">${player.correctAnswers} correct · ${player.incorrectAnswers || 0} missed</small></span><strong>${Number(player.totalScore).toLocaleString()} pts</strong></li>`
    ).join('');
  } catch (error) { toast(error.message); }
}

function route() {
  updateNav();
  const hash = location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  if (socket && socketConnectHandler) socket.off('connect', socketConnectHandler);
  if (socket && socketDisconnectHandler) socket.off('disconnect', socketDisconnectHandler);
  if (socket) {
    ['lobby:participants', 'game:question', 'game:progress', 'leaderboard:update', 'question:timeup', 'game:finished', 'game:error']
      .forEach(eventName => socket.off(eventName));
  }
  socketConnectHandler = null;
  socketDisconnectHandler = null;
  if (!parts.length) return landingPage();
  if (parts[0] === 'about' || parts[0] === 'how') {
    landingPage();
    document.getElementById(parts[0]).scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (parts[0] === 'login') return authPage('login');
  if (parts[0] === 'register') return authPage('register');
  if (parts[0] === 'admin') return adminDashboard(parts[1] || 'overview');
  if (parts[0] === 'teacher') return teacherDashboard();
  if (parts[0] === 'student') return studentDashboard();
  if (parts[0] === 'quizzes') return quizListPage();
  if (parts[0] === 'quiz' && parts[1] === 'new') return quizBuilderPage(null);
  if (parts[0] === 'quiz' && parts[1]) return quizBuilderPage(parts[1]);
  if (parts[0] === 'host') return hostPage();
  if (parts[0] === 'sessions') return sessionsPage();
  if (parts[0] === 'lobby' && parts[1]) return lobbyPage(parts[1]);
  if (parts[0] === 'play' && parts[1]) return playPage(parts[1]);
  if (parts[0] === 'game' && parts[1]) return gamePage(parts[1]);
  if (parts[0] === 'results' && parts[1]) return resultsPage(parts[1]);
  landingPage();
}

document.getElementById('navToggle').onclick = () => navLinks.classList.toggle('open');
window.addEventListener('hashchange', route);
route();

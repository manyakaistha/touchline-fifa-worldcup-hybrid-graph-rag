(() => {
  'use strict';

  const API = {
    status: '/api/status',
    query: '/api/query/stream',
    entities: '/api/entities',
    graph: '/api/graph',
  };
  const HISTORY_KEY = 'touchline.sessions.v1';
  const MAX_THREADS = 12;
  const MAX_TURNS = 16;
  const SUGGESTIONS = [
    { question: 'Who hosted the 1934 FIFA World Cup?', mode: 'graph', icon: '01' },
    { question: 'What happened in the 1930 World Cup final?', mode: 'semantic', icon: '02' },
    { question: 'How did Italy perform in the 1934 World Cup?', mode: 'hybrid', icon: '03' },
    { question: 'What do the sources say about the 1950 World Cup?', mode: 'auto', icon: '04' },
  ];

  const el = (id) => document.getElementById(id);
  const ui = {
    shell: document.querySelector('.app-shell'), sidebar: el('sidebar'), conversation: el('conversation'),
    messageList: el('message-list'), welcome: el('welcome'), sessionList: el('session-list'),
    historyCount: el('history-count'), currentTitle: el('current-title'), question: el('question-input'),
    form: el('query-form'), send: el('send-button'), mode: el('mode-select'), topK: el('top-k-select'),
    tournament: el('tournament-input'), generate: el('generate-toggle'), generateControl: el('generate-control'),
    generateLock: el('generate-lock'), healthPill: el('health-pill'), workspaceOrbit: el('workspace-orbit'),
    workspaceSummary: el('workspace-summary'), suggestionGrid: el('suggestion-grid'), evidenceList: el('evidence-list'),
    evidenceEmpty: el('evidence-empty'), evidenceIntro: el('evidence-intro'), evidenceCount: el('evidence-tab-count'),
    sourceCards: el('source-cards'), diagnostics: el('diagnostics-list'), entityForm: el('entity-search-form'),
    entitySearch: el('entity-search'), entityResults: el('entity-results'), graphSvg: el('graph-svg'),
    graphStage: el('graph-stage'), graphViewport: el('graph-viewport'), graphPlaceholder: el('graph-placeholder'),
    graphCount: el('graph-count'), graphListCount: el('graph-list-count'), graphNodeList: el('graph-node-list'),
    graphEdgeList: el('graph-edge-list'), graphSelection: el('graph-selection'), toastRegion: el('toast-region'),
    scrim: el('mobile-scrim'), inspector: el('inspector'),
  };

  const state = {
    status: null, statusError: '', threads: loadThreads(), currentThreadId: null, loading: false,
    activeTab: 'evidence', activeResult: null, graph: { nodes: [], edges: [] }, graphReady: false,
    selectedNode: null, selectedEdge: null, entityTimer: null, requestController: null,
    sidebarOpen: false, inspectorOpen: false, graphTransform: { x: 0, y: 0, scale: 1 },
    drag: null, graphSearchError: '', entitySearchSeq: 0,
  };

  function loadThreads() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((thread) => thread && typeof thread.id === 'string' && Array.isArray(thread.turns))
        .slice(0, MAX_THREADS).map((thread) => ({
          id: thread.id,
          title: typeof thread.title === 'string' ? thread.title : 'Untitled session',
          updatedAt: Number(thread.updatedAt) || Date.now(),
          turns: thread.turns.slice(-MAX_TURNS).filter((turn) => turn && typeof turn.question === 'string')
            .map((turn) => ({ question: turn.question, result: turn.result || null, error: turn.error || '' })),
        }));
    } catch (_) { return []; }
  }

  function saveThreads() {
    state.threads.sort((a, b) => b.updatedAt - a.updatedAt);
    state.threads = state.threads.slice(0, MAX_THREADS);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.threads)); } catch (_) { toast('This browser could not save session history.', true); }
  }

  function currentThread() { return state.threads.find((thread) => thread.id === state.currentThreadId) || null; }

  function createThread() {
    if (state.requestController) state.requestController.abort();
    state.requestController = null;
    state.loading = false;
    ui.send.disabled = false;
    const thread = { id: `s-${Date.now().toString(36)}-${Math.floor(performance.now()).toString(36)}`, title: 'New session', updatedAt: Date.now(), turns: [] };
    state.threads.unshift(thread);
    state.currentThreadId = thread.id;
    state.activeResult = null;
    state.graph = { nodes: [], edges: [] };
    state.graphReady = false;
    state.selectedNode = null;
    state.selectedEdge = null;
    state.graphTransform = { x: 0, y: 0, scale: 1 };
    ui.mode.value = 'hybrid';
    ui.tournament.value = '';
    ui.question.value = '';
    setActiveTab('evidence');
    saveThreads();
    renderHistory();
    renderConversation();
    renderGraph();
    closeDrawers();
    ui.question.focus({ preventScroll: true });
  }

  function restoreThread(id) {
    const thread = state.threads.find((item) => item.id === id);
    if (!thread) return;
    if (state.requestController) state.requestController.abort();
    state.requestController = null;
    state.loading = false;
    ui.send.disabled = false;
    state.currentThreadId = thread.id;
    const lastResult = [...thread.turns].reverse().find((turn) => turn.result)?.result;
    state.activeResult = lastResult || null;
    state.graph = normalizeGraph(lastResult?.graph);
    state.graphReady = !!lastResult;
    state.selectedNode = null;
    state.selectedEdge = null;
    state.graphTransform = { x: 0, y: 0, scale: 1 };
    renderHistory();
    renderConversation();
    renderEvidence(lastResult?.evidence || []);
    renderGraph();
    if (!lastResult) emptyEvidence();
    closeDrawers();
  }

  function titleForQuestion(question) {
    const singleLine = question.replace(/\s+/g, ' ').trim();
    return singleLine.length > 44 ? `${singleLine.slice(0, 43).trimEnd()}…` : singleLine;
  }

  function renderHistory() {
    ui.sessionList.replaceChildren();
    const threads = state.threads.filter((thread) => thread.turns.length > 0).slice(0, 12);
    ui.historyCount.textContent = String(threads.length);
    if (threads.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = 'Your questions will gather here as you explore the archive.';
      ui.sessionList.append(empty);
      return;
    }
    for (const thread of threads) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `session-item${thread.id === state.currentThreadId ? ' is-active' : ''}`;
      button.setAttribute('aria-current', thread.id === state.currentThreadId ? 'page' : 'false');
      const icon = document.createElement('span'); icon.className = 'session-item-icon'; icon.textContent = '↳'; icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span'); title.className = 'session-item-title'; title.textContent = thread.title || 'Untitled session';
      button.append(icon, title);
      button.addEventListener('click', () => restoreThread(thread.id));
      ui.sessionList.append(button);
    }
  }

  function renderSuggestions() {
    ui.suggestionGrid.replaceChildren();
    for (const suggestion of SUGGESTIONS) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'suggestion-card';
      button.setAttribute('aria-label', `${suggestion.question}, using ${suggestion.mode} mode`);
      const label = document.createElement('span'); label.textContent = suggestion.question;
      const arrow = document.createElement('span'); arrow.className = 'suggestion-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
      button.append(label, arrow);
      button.addEventListener('click', () => { ui.mode.value = suggestion.mode; ui.question.value = suggestion.question; resizeQuestion(); submitQuestion(); });
      ui.suggestionGrid.append(button);
    }
  }

  function renderConversation() {
    const thread = currentThread();
    const turns = thread?.turns || [];
    ui.messageList.replaceChildren();
    ui.conversation.classList.toggle('has-messages', turns.length > 0 || state.loading);
    ui.currentTitle.textContent = turns.length ? (thread.title || 'Research session') : 'New session';
    for (const turn of turns) renderTurn(turn);
    if (state.loading) ui.messageList.append(makeLoadingTurn());
    requestAnimationFrame(() => { ui.conversation.scrollTop = ui.conversation.scrollHeight; });
  }

  function renderTurn(turn) {
    const wrap = document.createElement('article'); wrap.className = 'turn';
    const qRow = document.createElement('div'); qRow.className = 'question-row';
    const bubble = document.createElement('div'); bubble.className = 'question-bubble'; bubble.textContent = turn.question;
    const userIcon = document.createElement('span'); userIcon.className = 'user-avatar'; userIcon.textContent = 'Y'; userIcon.setAttribute('aria-hidden', 'true');
    qRow.append(bubble, userIcon);
    wrap.append(qRow);
    const aRow = document.createElement('div'); aRow.className = 'answer-row';
    const assistantIcon = document.createElement('span'); assistantIcon.className = 'assistant-avatar'; assistantIcon.textContent = '✳'; assistantIcon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div'); body.className = 'answer-body';
    const result = turn.result;
    const meta = document.createElement('div'); meta.className = 'answer-meta';
    const name = document.createElement('strong'); name.textContent = result ? 'Touchline research' : 'Research desk';
    meta.append(name);
    if (result) {
      const pip = document.createElement('span'); pip.className = 'meta-pip'; pip.setAttribute('aria-hidden', 'true');
      const mode = document.createElement('span'); mode.textContent = humanMode(result.used_mode || result.requested_mode);
      const timing = document.createElement('span'); timing.textContent = formatElapsed(result.elapsed_ms);
      meta.append(pip, mode, timing);
    }
    body.append(meta);
    if (result) {
      const answer = document.createElement('div'); answer.className = `answer-copy${result.answer ? '' : ' is-empty'}`;
      appendAnswer(answer, result);
      body.append(answer);
      if (Array.isArray(result.diagnostics) && result.diagnostics.length) {
        for (const diagnostic of result.diagnostics) {
          const note = document.createElement('div'); note.className = 'diagnostic-inline'; note.textContent = diagnostic;
          body.append(note);
        }
      }
      const actions = document.createElement('div'); actions.className = 'answer-actions';
      const evidenceButton = actionButton(`⌕ ${countEvidence(result.evidence)} sources`, 'Open answer evidence');
      evidenceButton.addEventListener('click', () => { state.activeResult = result; renderEvidence(result.evidence || []); setActiveTab('evidence'); openInspector(); });
      const copyButton = actionButton('▢ Copy answer', 'Copy this answer');
      copyButton.addEventListener('click', () => copyText(`${turn.question}\n\n${result.answer || ''}`));
      const modeBadge = document.createElement('span'); modeBadge.className = 'answer-mode'; modeBadge.textContent = humanMode(result.used_mode || result.requested_mode);
      actions.append(evidenceButton, copyButton, modeBadge);
      body.append(actions);
      if (result.graph_query?.query) body.append(renderGraphQuery(result.graph_query));
    } else if (turn.error) {
      const error = document.createElement('div'); error.className = 'diagnostic-inline answer-error'; error.textContent = turn.error;
      body.append(error);
      const actions = document.createElement('div'); actions.className = 'answer-actions';
      const retry = actionButton('↻ Try again', 'Repeat this question');
      retry.addEventListener('click', () => { ui.question.value = turn.question; resizeQuestion(); submitQuestion(); });
      actions.append(retry); body.append(actions);
    } else {
      body.append(makeDots());
    }
    aRow.append(assistantIcon, body);
    wrap.append(aRow);
    ui.messageList.append(wrap);
  }

  function appendAnswer(element, result) {
    const text = result.answer || 'The service returned no generated answer. Review the evidence in the research desk.';
    for (const part of text.split(/(\*\*[^*]+\*\*|\[\d+\])/g)) {
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        const strong = document.createElement('strong'); strong.textContent = part.slice(2, -2); element.append(strong);
      } else if (/^\[\d+\]$/.test(part) && Number(part.slice(1, -1)) <= (result.evidence || []).length) {
        const citation = document.createElement('button'); citation.type = 'button'; citation.className = 'citation-button'; citation.textContent = part;
        citation.setAttribute('aria-label', `Open source ${part.slice(1, -1)}`);
        citation.addEventListener('click', () => {
          state.activeResult = result; renderEvidence(result.evidence || []); setActiveTab('evidence'); openInspector();
          const card = document.getElementById(`evidence-${Number(part.slice(1, -1))}`);
          if (card) { card.open = true; card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        }); element.append(citation);
      } else element.append(document.createTextNode(part));
    }
  }

  function actionButton(label, aria) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-action'; button.textContent = label; button.setAttribute('aria-label', aria); return button;
  }

  function renderGraphQuery(graphQuery) {
    const details = document.createElement('details'); details.className = 'query-details';
    const summary = document.createElement('summary');
    const title = document.createElement('span'); title.textContent = 'Graph query';
    const rows = document.createElement('span'); rows.textContent = `${graphQuery.rows.length} result row${graphQuery.rows.length === 1 ? '' : 's'}`;
    const arrow = document.createElement('span'); arrow.textContent = '⌄'; arrow.setAttribute('aria-hidden', 'true');
    summary.append(title, rows, arrow);
    const query = document.createElement('pre'); query.className = 'query-code'; query.textContent = graphQuery.query;
    details.append(summary, query);
    if (graphQuery.rows.length) {
      const resultHeading = document.createElement('div'); resultHeading.className = 'query-result-heading'; resultHeading.textContent = 'Returned graph rows'; details.append(resultHeading);
      const resultRows = document.createElement('pre'); resultRows.className = 'query-rows'; resultRows.textContent = JSON.stringify(graphQuery.rows, null, 2); details.append(resultRows);
    }
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'text-action'; copy.textContent = '▢ Copy query'; copy.addEventListener('click', () => copyText(graphQuery.query)); details.append(copy);
    return details;
  }

  function makeDots() {
    const box = document.createElement('div'); box.className = 'typing-indicator'; box.setAttribute('role', 'status'); box.setAttribute('aria-label', 'Searching the FIFA archive');
    for (let i = 0; i < 3; i += 1) { const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true'); box.append(dot); }
    const text = document.createElement('span'); text.textContent = 'Following the evidence…'; box.append(text); return box;
  }

  function makeLoadingTurn() {
    const turn = document.createElement('article'); turn.className = 'turn';
    const row = document.createElement('div'); row.className = 'answer-row';
    const avatar = document.createElement('span'); avatar.className = 'assistant-avatar'; avatar.textContent = '✳'; avatar.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div'); body.className = 'answer-body';
    const meta = document.createElement('div'); meta.className = 'answer-meta'; const name = document.createElement('strong'); name.textContent = 'Touchline research'; meta.append(name);
    body.append(meta, makeDots()); row.append(avatar, body); turn.append(row); return turn;
  }

  function humanMode(mode) {
    const names = { graph: 'Graph', semantic: 'Passages', hybrid: 'Hybrid', auto: 'Automatic' };
    return names[String(mode || '').toLowerCase()] || (mode ? String(mode) : 'Research');
  }

  function formatElapsed(ms) {
    const value = Number(ms);
    return Number.isFinite(value) && value >= 0 ? `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s` : '';
  }

  function countEvidence(evidence) { return Array.isArray(evidence) ? evidence.length : 0; }

  async function submitQuestion(event) {
    if (event) event.preventDefault();
    const question = ui.question.value.replace(/\s+/g, ' ').trim();
    if (question.length < 2) { toast('Add a little more detail to your question.', true); ui.question.focus(); return; }
    if (state.loading) return;
    let thread = currentThread();
    if (!thread || thread.turns.length === 0 && thread.title !== 'New session') {
      if (!thread) { createThread(); thread = currentThread(); }
    }
    if (!thread) { thread = { id: `s-${Date.now().toString(36)}`, title: 'New session', updatedAt: Date.now(), turns: [] }; state.threads.unshift(thread); state.currentThreadId = thread.id; }
    const turn = { question, result: null, error: '' };
    thread.turns.push(turn);
    thread.turns = thread.turns.slice(-MAX_TURNS);
    if (thread.title === 'New session' || !thread.title) thread.title = titleForQuestion(question);
    thread.updatedAt = Date.now();
    ui.question.value = '';
    resizeQuestion();
    state.loading = true;
    ui.send.disabled = true;
    state.requestController = new AbortController();
    renderHistory(); renderConversation();

    const payload = {
      question,
      mode: ui.mode.value,
      top_k: Number(ui.topK.value) || 6,
      generate: ui.generate.checked && !ui.generate.disabled,
      graph_reasoning: ui.generate.checked && !ui.generate.disabled && ui.mode.value !== 'semantic',
    };
    const tournament = ui.tournament.value.trim();
    if (tournament) payload.tournament = tournament;

    try {
      const response = await fetch(API.query, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload), signal: state.requestController.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(extractError(body, response.status));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '', streamed = '', receivedResult = false;
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = pending.split('\n\n'); pending = frames.pop();
        for (const frame of frames) {
          const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === 'result') {
            turn.result = normalizeQueryResponse(event.result); receivedResult = true;
            renderEvidence(turn.result.evidence);
            state.graph = normalizeGraph(turn.result.graph); state.graphReady = true; renderGraph();
          } else if (event.type === 'token' && turn.result) {
            streamed += event.text; turn.result.answer = streamed;
          } else if (event.type === 'complete' && turn.result) {
            turn.result.answer = event.answer; turn.result.generation = event.generation;
            turn.result.diagnostics.push(...(event.diagnostics || []));
            if (event.elapsed_ms) turn.result.elapsed_ms = event.elapsed_ms;
          }
        }
        if (state.currentThreadId === thread.id) renderConversation();
        if (done) break;
      }
      if (!receivedResult) throw new Error('The server stream ended without evidence. Please try again.');
      thread.updatedAt = Date.now();
      state.activeResult = turn.result;
      state.graph = normalizeGraph(turn.result.graph);
      state.graphReady = true;
      state.graphTransform = { x: 0, y: 0, scale: 1 };
      state.selectedNode = null; state.selectedEdge = null;
      renderEvidence(turn.result.evidence);
      renderGraph();
    } catch (error) {
      if (error.name === 'AbortError') {
        if (!turn.result) thread.turns = thread.turns.filter((item) => item !== turn);
      } else {
        turn.error = error.message || 'The research service could not complete this question.';
        emptyEvidence('The last request did not return evidence. Try the question again.');
        toast('The question could not be completed.', true);
      }
    } finally {
      if (state.currentThreadId === thread.id) {
        state.loading = false;
        state.requestController = null;
        ui.send.disabled = false;
        saveThreads(); renderHistory(); renderConversation();
      }
    }
  }

  function normalizeQueryResponse(response) {
    const evidence = Array.isArray(response?.evidence) ? response.evidence.map(normalizeEvidence) : [];
    return {
      question: String(response?.question || ''),
      requested_mode: String(response?.requested_mode || ''),
      used_mode: String(response?.used_mode || ''),
      answer: typeof response?.answer === 'string' ? response.answer : '',
      evidence,
      diagnostics: Array.isArray(response?.diagnostics) ? response.diagnostics.map(String) : [],
      generation: String(response?.generation || ''),
      elapsed_ms: Number(response?.elapsed_ms),
      graph: normalizeGraph(response?.graph),
      graph_query: response?.graph_query && typeof response.graph_query === 'object' ? {
        query: String(response.graph_query.query || ''),
        rows: Array.isArray(response.graph_query.rows) ? response.graph_query.rows : [],
      } : null,
    };
  }

  function normalizeEvidence(item) {
    return {
      id: String(item?.id || ''), text: String(item?.text || ''), source: String(item?.source || ''),
      score: Number(item?.score), methods: Array.isArray(item?.methods) ? item.methods.map(String) : [],
      entities: Array.isArray(item?.entities) ? item.entities.map(String) : [],
      metadata: item?.metadata && typeof item.metadata === 'object' ? item.metadata : {},
    };
  }

  function normalizeGraph(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map((node) => ({
      id: String(node?.id ?? node?.name ?? ''), name: String(node?.name ?? node?.id ?? ''), label: String(node?.label ?? node?.type ?? 'Entity'),
      properties: node?.properties && typeof node.properties === 'object' ? node.properties : {},
    })).filter((node) => node.id) : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges.map((edge) => ({
      source: String(edge?.source?.id ?? edge?.source ?? ''), target: String(edge?.target?.id ?? edge?.target ?? ''),
      type: String(edge?.type ?? edge?.label ?? edge?.relation_type ?? edge?.relation ?? 'RELATED_TO'),
      properties: edge?.properties && typeof edge.properties === 'object' ? edge.properties : {},
    })).filter((edge) => edge.source && edge.target) : [];
    return { nodes, edges };
  }

  function extractError(body, status) {
    const detail = body?.detail ?? body?.message ?? body?.error;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map((item) => item.msg || JSON.stringify(item)).join(' ');
    return `Request failed (${status}). Check the local service status and try again.`;
  }

  function renderEvidence(evidence) {
    const items = Array.isArray(evidence) ? evidence : [];
    ui.evidenceList.replaceChildren();
    ui.evidenceCount.textContent = items.length ? String(items.length) : '';
    ui.evidenceIntro.textContent = items.length ? `${items.length} passage${items.length === 1 ? '' : 's'} and their extracted context support this response.` : 'No source passages were returned for this question.';
    ui.evidenceEmpty.hidden = items.length > 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = normalizeEvidence(items[index]);
      const card = document.createElement('details'); card.className = 'evidence-card'; card.id = `evidence-${index + 1}`;
      const summary = document.createElement('summary'); summary.className = 'evidence-summary';
      const top = document.createElement('div'); top.className = 'evidence-summary-top';
      const number = document.createElement('span'); number.className = 'evidence-number'; number.textContent = `SOURCE ${String(index + 1).padStart(2, '0')}`;
      const score = document.createElement('span'); score.className = 'evidence-score'; score.title = 'Retrieval ranking score, not factual confidence';
      score.textContent = Number.isFinite(item.score) && item.score !== 0 ? `● ${item.score.toFixed(2)}` : '';
      top.append(number, score);
      const title = document.createElement('div'); title.className = 'evidence-title'; title.textContent = evidenceTitle(item, index);
      const context = /^\[Context:\s*(.*?)\s*\|\s*Section:\s*(.*?)\]\s*/s.exec(item.text);
      const passage = context ? item.text.slice(context[0].length) : item.text;
      const edition = document.createElement('div'); edition.className = 'evidence-edition'; edition.textContent = item.metadata?.tournament || context?.[1] || item.source;
      const preview = document.createElement('div'); preview.className = 'evidence-preview'; preview.textContent = passage || 'No passage text was returned.';
      const bottom = document.createElement('div'); bottom.className = 'evidence-summary-bottom';
      const source = document.createElement('span'); source.className = 'evidence-source'; source.textContent = item.source || item.id || 'Source record';
      bottom.append(source);
      if (item.methods.length) { const dot = document.createElement('span'); dot.textContent = '·'; const methods = document.createElement('span'); methods.textContent = item.methods.join(' + '); bottom.append(dot, methods); }
      const chevron = document.createElement('span'); chevron.className = 'evidence-chevron'; chevron.textContent = '⌄'; chevron.setAttribute('aria-hidden', 'true'); bottom.append(chevron);
      summary.append(top, edition, title, preview, bottom);
      const content = document.createElement('div'); content.className = 'evidence-content';
      const text = document.createElement('div'); text.className = 'evidence-full-text';
      for (const paragraph of (passage || 'No passage text was returned.').split(/\n\s*\n/)) { const p = document.createElement('p'); p.textContent = paragraph; text.append(p); }
      const provenance = document.createElement('div'); provenance.className = 'evidence-provenance'; provenance.textContent = `Archive reference · ${item.id}`;
      content.append(text, provenance);
      if (item.entities.length) {
        const chips = document.createElement('div'); chips.className = 'evidence-metadata';
        for (const entity of item.entities) {
          const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'entity-chip'; chip.textContent = entity;
          chip.addEventListener('click', () => { ui.entitySearch.value = entity; setActiveTab('graph'); openInspector(); void searchEntities(); });
          chips.append(chip);
        }
        content.append(chips);
      }
      const actions = document.createElement('div'); actions.className = 'evidence-actions';
      const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy passage'; copy.addEventListener('click', () => copyText(item.text)); actions.append(copy);
      content.append(actions);
      card.append(summary, content);
      ui.evidenceList.append(card);
    }
  }

  function evidenceTitle(item, index) {
    const label = item.metadata?.title || item.metadata?.section || item.metadata?.tournament;
    return String(label || item.source || item.id || `Archive passage ${index + 1}`);
  }

  function emptyEvidence(message) {
    ui.evidenceList.replaceChildren(); ui.evidenceCount.textContent = '';
    ui.evidenceIntro.textContent = message || 'Ask a question to inspect the passages and entities behind the answer.';
    ui.evidenceEmpty.hidden = false;
  }

  async function refreshStatus() {
    ui.healthPill.classList.remove('is-up', 'is-down');
    ui.healthPill.querySelector('span').textContent = 'Connecting';
    ui.workspaceSummary.textContent = 'Checking connected sources…';
    try {
      const response = await fetch(API.status, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(extractError(body, response.status));
      state.status = body; state.statusError = '';
      updateStatusView();
    } catch (error) {
      state.status = null; state.statusError = error.message || 'The local service is unavailable.';
      updateStatusView();
    }
  }

  function updateStatusView() {
    const status = state.status || {};
    const graph = status.graph || {};
    const semantic = status.semantic || {};
    const generation = status.generation || {};
    const anySource = graph.available === true || semantic.available === true;
    const knownSource = typeof graph.available === 'boolean' || typeof semantic.available === 'boolean';
    ui.healthPill.classList.toggle('is-up', anySource);
    ui.healthPill.classList.toggle('is-down', knownSource && !anySource || !!state.statusError);
    ui.healthPill.querySelector('span').textContent = state.statusError ? 'Offline' : anySource ? 'Archive ready' : knownSource ? 'No source' : 'Status unknown';
    ui.workspaceOrbit.classList.toggle('is-up', anySource);
    ui.workspaceOrbit.classList.toggle('is-down', state.statusError || knownSource && !anySource);
    const sourceCount = countObjectValues(graph.node_counts) + Number(semantic.document_count ?? 0);
    const hasCounts = graph.node_counts && typeof graph.node_counts === 'object' || typeof semantic.document_count === 'number';
    ui.workspaceSummary.textContent = state.statusError ? 'Could not reach the local research service.' : hasCounts ? `${formatCount(sourceCount)} indexed records across connected sources.` : anySource ? 'One or more archive sources are available.' : knownSource ? 'The service reported no available archive sources.' : 'Connection details were not provided.';
    const canGenerate = generation.configured === true && generation.enabled === true;
    ui.generate.disabled = !canGenerate;
    ui.generate.checked = canGenerate ? ui.generate.checked : false;
    ui.generateControl.title = canGenerate ? `Plans graph queries and writes cited answers; uses your Groq key · ${generation.model || 'Groq'}` : generation.configured === true ? 'Groq reasoning is configured but disabled by the local service.' : 'Groq reasoning is unavailable until the local service is configured and enabled.';
    ui.generateControl.setAttribute('aria-label', canGenerate ? `Groq reasoning with ${generation.model || 'configured model'}` : 'Groq reasoning is unavailable');
    updateSourceCards(status, state.statusError);
  }

  function formatCount(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '0'; }

  function updateSourceCards(status, error) {
    ui.sourceCards.replaceChildren();
    if (error) {
      const card = sourceCard('Local service', false, 'Unavailable', 'The status endpoint did not return a connection report.', error);
      ui.sourceCards.append(card);
      renderDiagnostics([error], true);
      return;
    }
    const graph = status.graph || {};
    const semantic = status.semantic || {};
    const generation = status.generation || {};
    const graphNodes = graph.node_counts || {};
    const graphRels = graph.relationship_counts || {};
    const graphTotal = countObjectValues(graphNodes);
    const relTotal = countObjectValues(graphRels);
    ui.sourceCards.append(sourceCard('Knowledge graph', graph.available === true,
      graph.available === true ? formatCount(graphTotal) : 'Unavailable',
      graph.available === true ? `${formatCount(relTotal)} relationship records · Kuzu` : 'Graph database availability reported by the service.', graph.error));
    ui.sourceCards.append(sourceCard('Source passages', semantic.available === true,
      semantic.available === true ? formatCount(semantic.document_count ?? 0) : 'Unavailable',
      semantic.method ? `Retrieval method · ${semantic.method}` : 'Semantic source status reported by the service.', semantic.error));
    ui.sourceCards.append(sourceCard('Answer generation', generation.configured === true && generation.enabled === true,
      generation.configured === true && generation.enabled === true ? 'Enabled' : generation.configured === true ? 'Disabled' : 'Not configured',
      generation.model ? `Plans graph queries and writes cited answers · ${generation.model} via Groq` : 'Plans graph queries and writes cited answers; uses your Groq key.', generation.error));
    const diagnostics = [...(graph.warnings || [])];
    for (const [label, value] of [['Graph', graph.error], ['Passages', semantic.error], ['Generation', generation.error]]) {
      if (value) diagnostics.push(`${label}: ${value}`);
    }
    for (const value of Array.isArray(status.diagnostics) ? status.diagnostics : []) diagnostics.push(String(value));
    if (status.data_note) diagnostics.push(String(status.data_note));
    renderDiagnostics(diagnostics, false);
  }

  function countObjectValues(object) {
    if (!object || typeof object !== 'object') return 0;
    if (Number.isFinite(Number(object.total))) return Number(object.total);
    return Object.values(object).reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
  }

  function sourceCard(titleText, available, metricText, descriptionText, errorText) {
    const card = document.createElement('article'); card.className = 'source-card';
    const head = document.createElement('div'); head.className = 'source-card-head';
    const title = document.createElement('span'); title.textContent = titleText;
    const badge = document.createElement('span'); badge.className = `source-status ${available ? 'is-up' : 'is-down'}`; badge.textContent = available ? 'Available' : 'Unavailable';
    head.append(title, badge);
    const metric = document.createElement('div'); metric.className = 'source-card-metric'; metric.textContent = metricText;
    const desc = document.createElement('div'); desc.className = 'source-card-desc'; desc.textContent = descriptionText;
    card.append(head, metric, desc);
    if (errorText) { const error = document.createElement('div'); error.className = 'source-card-error'; error.textContent = String(errorText); card.append(error); }
    return card;
  }

  function renderDiagnostics(items, isError) {
    ui.diagnostics.replaceChildren();
    if (!items.length) { const empty = document.createElement('div'); empty.className = 'diagnostics-empty'; empty.textContent = isError ? 'No further diagnostic detail.' : 'No diagnostics were reported.'; ui.diagnostics.append(empty); return; }
    for (const item of items) { const row = document.createElement('div'); row.className = `diagnostic-item${isError ? ' is-error' : ''}`; row.textContent = item; ui.diagnostics.append(row); }
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    for (const name of ['evidence', 'graph', 'system']) {
      const button = el(`tab-${name}`); const panel = el(`panel-${name}`); const active = name === tab;
      button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      panel.classList.toggle('is-active', active); panel.hidden = !active;
    }
  }

  function renderGraph() {
    const graph = state.graph;
    const nodes = graph.nodes;
    const edges = graph.edges;
    ui.graphStage.replaceChildren();
    ui.graphNodeList.replaceChildren(); ui.graphEdgeList.replaceChildren(); ui.graphSelection.replaceChildren();
    ui.graphCount.textContent = nodes.length || edges.length ? `${nodes.length} entities · ${edges.length} relationships` : 'No graph loaded';
    ui.graphListCount.textContent = String(nodes.length);
    ui.graphPlaceholder.hidden = nodes.length > 0 || edges.length > 0;
    const legend = ensureGraphLegend(nodes);
    if (!nodes.length && !edges.length) { legend.hidden = true; return; }
    legend.hidden = false;

    const { positions: layout, boardSize, rootId } = positionNodes(nodes, edges);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nodeRadii = new Map(nodes.map((node) => [node.id, nodeRadius(node, node.id === rootId)]));
    const graphSvg = document.getElementById('graph-svg');
    graphSvg.setAttribute('viewBox', `0 0 ${boardSize} ${boardSize}`);
    const svgNS = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(svgNS, 'defs');
    const marker = document.createElementNS(svgNS, 'marker'); marker.setAttribute('id', 'touchline-edge-arrow'); marker.setAttribute('viewBox', '0 0 8 8');
    marker.setAttribute('refX', '6.6'); marker.setAttribute('refY', '4'); marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6'); marker.setAttribute('orient', 'auto-start-reverse');
    const arrow = document.createElementNS(svgNS, 'path'); arrow.setAttribute('d', 'M 0 1 L 7 4 L 0 7 z'); arrow.setAttribute('class', 'graph-arrowhead'); marker.append(arrow); defs.append(marker);
    const edgeLayer = document.createElementNS(svgNS, 'g'); edgeLayer.setAttribute('class', 'graph-edge-layer');
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index]; const source = layout.get(edge.source); const target = layout.get(edge.target);
      if (!source || !target) continue;
      const isRelated = state.selectedNode && (edge.source === state.selectedNode || edge.target === state.selectedNode);
      const isDimmed = state.selectedNode && !isRelated;
      const group = document.createElementNS(svgNS, 'g');
      group.setAttribute('class', `graph-edge-group${state.selectedEdge === index ? ' is-selected' : ''}${isRelated ? ' is-related' : ''}${isDimmed ? ' is-dimmed' : ''}`);
      group.dataset.edgeIndex = String(index);
      group.dataset.source = edge.source; group.dataset.target = edge.target;
      const d = graphEdgePath(source, target, index, nodeRadii.get(edge.source), nodeRadii.get(edge.target));
      const hit = document.createElementNS(svgNS, 'path'); hit.setAttribute('d', d); hit.setAttribute('class', 'graph-edge-hit');
      hit.setAttribute('tabindex', '0'); hit.setAttribute('role', 'button');
      hit.setAttribute('aria-label', `${nodeById.get(edge.source)?.name || edge.source} ${edge.type} ${nodeById.get(edge.target)?.name || edge.target}`);
      const stroke = document.createElementNS(svgNS, 'path'); stroke.setAttribute('d', d); stroke.setAttribute('class', 'graph-edge');
      stroke.dataset.type = edge.type; stroke.setAttribute('marker-end', 'url(#touchline-edge-arrow)'); stroke.setAttribute('aria-hidden', 'true');
      const mid = graphEdgeMidpoint(source, target, index);
      const relation = document.createElementNS(svgNS, 'text'); relation.setAttribute('class', 'graph-edge-label'); relation.setAttribute('x', String(mid.x)); relation.setAttribute('y', String(mid.y - 4));
      relation.textContent = truncate(edge.type.replaceAll('_', ' ').toLowerCase(), 18); relation.setAttribute('aria-hidden', 'true');
      hit.addEventListener('mouseenter', () => group.classList.add('is-hovered'));
      hit.addEventListener('mouseleave', () => group.classList.remove('is-hovered'));
      hit.addEventListener('focus', () => group.classList.add('is-hovered'));
      hit.addEventListener('blur', () => group.classList.remove('is-hovered'));
      hit.addEventListener('click', (event) => { event.stopPropagation(); selectEdge(index); });
      hit.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectEdge(index); } });
      group.append(stroke, relation, hit); edgeLayer.append(group);
    }
    const nodeLayer = document.createElementNS(svgNS, 'g'); nodeLayer.setAttribute('class', 'graph-node-layer');
    const selectedEdge = state.selectedEdge === null ? null : edges[state.selectedEdge];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]; const point = layout.get(node.id); if (!point) continue;
      const isRoot = node.id === rootId;
      const isRelated = selectedEdge && (selectedEdge.source === node.id || selectedEdge.target === node.id);
      const isDimmed = (state.selectedNode && state.selectedNode !== node.id && !edges.some((edge) =>
        (edge.source === state.selectedNode && edge.target === node.id) || (edge.target === state.selectedNode && edge.source === node.id))) ||
        (selectedEdge && !isRelated);
      const radius = nodeRadii.get(node.id);
      const group = document.createElementNS(svgNS, 'g'); group.setAttribute('class', `graph-node${isRoot ? ' is-focus-node' : ''}${state.selectedNode === node.id ? ' is-selected' : ''}${isRelated ? ' is-related' : ''}${isDimmed ? ' is-dimmed' : ''}`);
      group.setAttribute('data-label', node.label); group.setAttribute('data-node-id', node.id); group.setAttribute('transform', `translate(${point.x} ${point.y})`); group.setAttribute('tabindex', '0'); group.setAttribute('role', 'button');
      group.setAttribute('aria-label', `${node.label}: ${node.name}`);
      const title = document.createElementNS(svgNS, 'title'); title.textContent = `${node.label}: ${node.name}`;
      const orbit = document.createElementNS(svgNS, 'circle'); orbit.setAttribute('class', 'node-orbit'); orbit.setAttribute('r', String(radius + 9));
      const halo = document.createElementNS(svgNS, 'circle'); halo.setAttribute('class', 'node-halo'); halo.setAttribute('r', String(radius));
      const center = document.createElementNS(svgNS, 'circle'); center.setAttribute('class', 'node-core'); center.setAttribute('cx', '0'); center.setAttribute('cy', isRoot ? '-17' : '-12'); center.setAttribute('r', isRoot ? '3.5' : '2.8');
      const nameLines = wrapGraphLabel(node.name, isRoot ? 15 : 12);
      if (nameLines.length > 1) center.setAttribute('cy', '-26');
      const label = document.createElementNS(svgNS, 'text'); label.setAttribute('class', 'node-name'); label.setAttribute('text-anchor', 'middle'); label.setAttribute('y', nameLines.length > 1 ? '-5' : '4');
      for (let line = 0; line < nameLines.length; line += 1) {
        const span = document.createElementNS(svgNS, 'tspan'); span.setAttribute('x', '0'); span.setAttribute('dy', line === 0 ? '0' : '14'); span.textContent = nameLines[line]; label.append(span);
      }
      const type = document.createElementNS(svgNS, 'text'); type.setAttribute('class', 'node-label-type'); type.setAttribute('text-anchor', 'middle'); type.setAttribute('y', nameLines.length > 1 ? '24' : '20'); type.textContent = node.label;
      group.append(title, orbit, halo, center, label, type);
      group.addEventListener('mouseenter', () => highlightNodeNeighborhood(node.id, true));
      group.addEventListener('mouseleave', () => highlightNodeNeighborhood(node.id, false));
      group.addEventListener('focus', () => highlightNodeNeighborhood(node.id, true));
      group.addEventListener('blur', () => highlightNodeNeighborhood(node.id, false));
      group.addEventListener('click', (event) => { event.stopPropagation(); selectNode(node); });
      group.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectNode(node); } });
      nodeLayer.append(group);
    }
    ui.graphStage.append(defs, edgeLayer, nodeLayer);
    applyGraphTransform();
    for (const node of nodes) {
      const button = document.createElement('button'); button.type = 'button'; button.className = `graph-list-item${state.selectedNode === node.id ? ' is-selected' : ''}`;
      const dot = document.createElement('i'); dot.className = 'graph-list-dot'; dot.dataset.label = node.label; dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.className = 'graph-list-label'; name.textContent = node.name;
      const type = document.createElement('span'); type.className = 'graph-list-type'; type.textContent = node.label;
      if (node.id === rootId) button.setAttribute('aria-label', `${node.name}, ${node.label}, focus entity`);
      button.append(dot, name, type); button.addEventListener('click', () => selectNode(node)); ui.graphNodeList.append(button);
    }
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index]; const button = document.createElement('button'); button.type = 'button'; button.className = `graph-list-item graph-edge-item${state.selectedEdge === index ? ' is-selected' : ''}`;
      const dot = document.createElement('i'); dot.className = 'graph-list-dot'; dot.style.background = '#9aaa67'; dot.setAttribute('aria-hidden', 'true');
      const sourceName = nodeById.get(edge.source)?.name || edge.source;
      const targetName = nodeById.get(edge.target)?.name || edge.target;
      const name = document.createElement('span'); name.className = 'graph-list-label'; name.textContent = `${sourceName} → ${edge.type} → ${targetName}`;
      button.append(dot, name); button.addEventListener('click', () => selectEdge(index)); ui.graphEdgeList.append(button);
    }
  }

  function positionNodes(nodes, edges) {
    const positions = new Map();
    if (!nodes.length) return { positions, boardSize: 560, rootId: null };
    const degree = new Map(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      if (degree.has(edge.source)) degree.set(edge.source, degree.get(edge.source) + 1);
      if (degree.has(edge.target)) degree.set(edge.target, degree.get(edge.target) + 1);
    }
    let root = nodes[0];
    for (const node of nodes) if ((degree.get(node.id) || 0) > (degree.get(root.id) || 0)) root = node;
    const satellites = nodes.filter((node) => node.id !== root.id).sort((a, b) => {
      const labels = ['Tournament', 'Team', 'Player', 'Match', 'Stadium', 'Award'];
      const type = labels.indexOf(a.label) - labels.indexOf(b.label);
      return type || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
    const ringRadii = satellites.length <= 7 ? [152] : satellites.length <= 18 ? [132, 230] : satellites.length <= 34 ? [120, 208, 296] : [112, 194, 276, 358];
    const center = { x: 0, y: 0 };
    positions.set(root.id, center);
    let cursor = 0;
    const arcSpacing = 112;
    for (let ring = 0; cursor < satellites.length; ring += 1) {
      const radius = ringRadii[ring] || ringRadii.at(-1) + (ring - ringRadii.length + 1) * 92;
      const capacity = Math.max(5, Math.floor((Math.PI * 2 * radius) / arcSpacing));
      const count = Math.min(capacity, satellites.length - cursor);
      const phase = -Math.PI / 2 + ring * 2.399963229728653;
      for (let offset = 0; offset < count; offset += 1) {
        const node = satellites[cursor + offset];
        const angle = phase + (Math.PI * 2 * offset / count);
        positions.set(node.id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
      }
      cursor += count;
    }
    const actualOuter = Math.max(152, ...[...positions.values()].map((point) => Math.hypot(point.x, point.y)));
    const boardSize = Math.max(560, Math.ceil((actualOuter + 86) * 2));
    const offset = boardSize / 2;
    for (const point of positions.values()) { point.x += offset; point.y += offset; }
    return { positions, boardSize, rootId: root.id };
  }

  function graphEdgePath(source, target, index, sourceRadius = 0, targetRadius = 0) {
    const dx = target.x - source.x; const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const bendSign = index % 2 === 0 ? 1 : -1;
    const bend = Math.min(46, distance * .13) * bendSign;
    const nx = -dy / distance; const ny = dx / distance;
    const c1x = source.x + dx * .34 + nx * bend; const c1y = source.y + dy * .34 + ny * bend;
    const c2x = source.x + dx * .68 + nx * bend; const c2y = source.y + dy * .68 + ny * bend;
    const startLength = Math.max(1, Math.hypot(c1x - source.x, c1y - source.y));
    const endLength = Math.max(1, Math.hypot(target.x - c2x, target.y - c2y));
    const startX = source.x + (c1x - source.x) / startLength * sourceRadius;
    const startY = source.y + (c1y - source.y) / startLength * sourceRadius;
    const endX = target.x - (target.x - c2x) / endLength * targetRadius;
    const endY = target.y - (target.y - c2y) / endLength * targetRadius;
    return `M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`;
  }

  function nodeRadius(node, isRoot) {
    return isRoot ? Math.max(46, Math.min(60, 23 + Math.min(20, node.name.length) * 1.55)) : 41;
  }

  function wrapGraphLabel(value, maxChars) {
    const words = value.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return ['Entity'];
    const lines = [''];
    for (const word of words) {
      const current = lines[lines.length - 1];
      if (current && `${current} ${word}`.length > maxChars && lines.length < 2) lines.push(word);
      else lines[lines.length - 1] = current ? `${current} ${word}` : word;
    }
    lines[0] = truncate(lines[0], maxChars);
    if (lines.length > 1) lines[1] = truncate(lines[1], maxChars);
    return lines;
  }

  function graphEdgeMidpoint(source, target, index) {
    const dx = target.x - source.x; const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const bend = Math.min(46, distance * .13) * (index % 2 === 0 ? 1 : -1);
    return { x: (source.x + target.x) / 2 - dy / distance * bend, y: (source.y + target.y) / 2 + dx / distance * bend };
  }

  function ensureGraphLegend(nodes) {
    const panel = document.getElementById('panel-graph');
    let legend = panel.querySelector('.graph-type-legend');
    if (!legend) {
      legend = document.createElement('div'); legend.className = 'graph-type-legend'; legend.setAttribute('aria-label', 'Graph node type legend');
      ui.graphViewport.parentNode.insertBefore(legend, ui.graphViewport);
    }
    legend.replaceChildren();
    const present = [...new Set(nodes.map((node) => node.label))];
    const order = ['Tournament', 'Team', 'Player', 'Match', 'Stadium', 'Award'];
    for (const label of order.filter((item) => present.includes(item))) {
      const item = document.createElement('span'); item.className = 'graph-legend-item';
      const swatch = document.createElement('i'); swatch.className = 'graph-legend-swatch'; swatch.dataset.label = label; swatch.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); text.textContent = label;
      item.append(swatch, text); legend.append(item);
    }
    if (nodes.length) {
      const focus = document.createElement('span'); focus.className = 'graph-legend-item graph-legend-focus';
      const mark = document.createElement('i'); mark.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); text.textContent = 'Most connected'; focus.append(mark, text); legend.append(focus);
    }
    return legend;
  }

  function selectNode(node) {
    state.selectedNode = node.id; state.selectedEdge = null; renderGraph();
    const info = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = node.name;
    const detail = document.createElement('span'); detail.textContent = `${node.label} · connected to ${state.graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length} relationship(s)`;
    info.append(title, detail);
    if (Object.keys(node.properties || {}).length) info.append(renderGraphProperties(node.properties));
    ui.graphSelection.append(info);
  }

  function selectEdge(index) {
    const edge = state.graph.edges[index]; if (!edge) return;
    state.selectedEdge = index; state.selectedNode = null; renderGraph();
    const nodeById = new Map(state.graph.nodes.map((node) => [node.id, node]));
    const info = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = edge.type;
    const detail = document.createElement('span'); detail.textContent = `${nodeById.get(edge.source)?.name || edge.source} → ${nodeById.get(edge.target)?.name || edge.target}`;
    info.append(title, detail);
    if (Object.keys(edge.properties || {}).length) info.append(renderGraphProperties(edge.properties));
    ui.graphSelection.append(info);
  }

  function renderGraphProperties(properties) {
    const list = document.createElement('dl');
    list.className = 'graph-properties';
    for (const [key, value] of Object.entries(properties || {})) {
      const term = document.createElement('dt');
      term.textContent = key.replaceAll('_', ' ');
      const description = document.createElement('dd');
      description.textContent = value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value);
      list.append(term, description);
    }
    return list;
  }

  function truncate(value, max) { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }

  function applyGraphTransform() {
    const t = state.graphTransform;
    const box = ui.graphSvg.viewBox.baseVal;
    const centerX = box.width / 2; const centerY = box.height / 2;
    ui.graphStage.setAttribute('transform', `translate(${centerX + t.x} ${centerY + t.y}) scale(${t.scale}) translate(${-centerX} ${-centerY})`);
  }

  function highlightNodeNeighborhood(nodeId, enabled) {
    for (const group of ui.graphStage.querySelectorAll('.graph-edge-group')) {
      const related = group.dataset.source === nodeId || group.dataset.target === nodeId;
      group.classList.toggle('is-node-hover', enabled && related);
    }
  }

  async function fetchGraph(options = {}) {
    const params = new URLSearchParams(); params.set('limit', '40');
    if (options.entity) params.set('entity', options.entity);
    if (options.label) params.set('label', options.label);
    ui.graphPlaceholder.hidden = false;
    ui.graphPlaceholder.querySelector('span:last-child').textContent = options.entity ? `Following connections for ${options.entity}…` : 'Loading connected records…';
    try {
      const response = await fetch(`${API.graph}?${params.toString()}`, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(extractError(data, response.status));
      state.graph = normalizeGraph(data); state.graphReady = true; state.graphSearchError = '';
      state.graphTransform = { x: 0, y: 0, scale: 1 }; state.selectedNode = null; state.selectedEdge = null;
      if (state.graph.nodes.length || state.graph.edges.length) ui.graphPlaceholder.hidden = true;
      else ui.graphPlaceholder.querySelector('span:last-child').textContent = options.entity ? 'No matching connected records were returned.' : 'No graph records were returned by the service.';
      renderGraph();
    } catch (error) {
      state.graphSearchError = error.message || 'The graph endpoint could not be reached.';
      ui.graphPlaceholder.hidden = false;
      ui.graphPlaceholder.querySelector('span:last-child').textContent = state.graphSearchError;
      if (!options.silent) toast(state.graphSearchError, true);
    }
  }

  async function searchEntities(event) {
    if (event) event.preventDefault();
    const query = ui.entitySearch.value.trim();
    if (!query) {
      state.entitySearchSeq += 1;
      ui.entityResults.hidden = true; ui.entityResults.replaceChildren();
      if (state.activeResult?.graph) state.graph = normalizeGraph(state.activeResult.graph);
      else state.graph = { nodes: [], edges: [] };
      renderGraph();
      if (!state.graph.nodes.length && !state.graph.edges.length) ui.graphPlaceholder.querySelector('span:last-child').textContent = 'Search for an entity to explore its relationships.';
      return;
    }
    const searchSequence = ++state.entitySearchSeq;
    const params = new URLSearchParams({ q: query, limit: '20' });
    ui.entityResults.hidden = false; ui.entityResults.replaceChildren();
    const loading = document.createElement('div'); loading.className = 'diagnostics-empty'; loading.textContent = 'Searching entities…'; ui.entityResults.append(loading);
    try {
      const response = await fetch(`${API.entities}?${params.toString()}`, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(extractError(data, response.status));
      if (searchSequence !== state.entitySearchSeq) return;
      ui.entityResults.replaceChildren();
      const entities = Array.isArray(data.entities) ? data.entities : [];
      if (!entities.length) { const empty = document.createElement('div'); empty.className = 'diagnostics-empty'; empty.textContent = 'No matching entities were returned.'; ui.entityResults.append(empty); return; }
      for (const entity of entities) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'entity-result';
        button.setAttribute('role', 'option');
        const name = document.createElement('span'); name.textContent = String(entity.id ?? '');
        const label = document.createElement('small'); label.textContent = String(entity.label ?? 'Entity');
        button.append(name, label);
        button.addEventListener('click', () => { ui.entitySearch.value = String(entity.id ?? ''); ui.entityResults.hidden = true; ui.entityResults.replaceChildren(); void fetchGraph({ entity: String(entity.id ?? ''), label: String(entity.label ?? '') }); });
        ui.entityResults.append(button);
      }
    } catch (error) {
      if (searchSequence !== state.entitySearchSeq) return;
      ui.entityResults.replaceChildren(); const message = document.createElement('div'); message.className = 'diagnostics-empty'; message.textContent = error.message; ui.entityResults.append(message);
    }
  }

  function handleGraphWheel(event) {
    if (!state.graph.nodes.length && !state.graph.edges.length) return;
    event.preventDefault();
    const scale = Math.max(.55, Math.min(2.2, state.graphTransform.scale * (event.deltaY < 0 ? 1.1 : .9)));
    state.graphTransform.scale = scale; applyGraphTransform();
  }

  function handleGraphPointerDown(event) {
    if (event.button !== 0 || event.target.closest('.graph-node, .graph-edge-group')) return;
    state.drag = { x: event.clientX, y: event.clientY, ox: state.graphTransform.x, oy: state.graphTransform.y, pointerId: event.pointerId };
    ui.graphViewport.classList.add('is-dragging'); ui.graphViewport.setPointerCapture?.(event.pointerId);
  }

  function handleGraphPointerMove(event) {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    const box = ui.graphSvg.viewBox.baseVal;
    const scale = Math.min(ui.graphViewport.clientWidth / (box.width || 520), ui.graphViewport.clientHeight / (box.height || 360));
    state.graphTransform.x = state.drag.ox + (event.clientX - state.drag.x) / (scale || 1);
    state.graphTransform.y = state.drag.oy + (event.clientY - state.drag.y) / (scale || 1);
    applyGraphTransform();
  }

  function handleGraphPointerUp(event) {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    state.drag = null; ui.graphViewport.classList.remove('is-dragging');
  }

  function graphZoom(amount) {
    state.graphTransform.scale = Math.max(.55, Math.min(2.2, state.graphTransform.scale * amount)); applyGraphTransform();
  }

  function resetGraphView() { state.graphTransform = { x: 0, y: 0, scale: 1 }; applyGraphTransform(); }

  function openInspector() {
    state.inspectorOpen = true; state.sidebarOpen = false; updateDrawers();
  }
  function toggleInspector() {
    if (window.matchMedia('(max-width: 1080px)').matches) state.inspectorOpen = !state.inspectorOpen;
    else ui.shell.classList.toggle('inspector-hidden');
    updateDrawers();
  }
  function openSidebar() { state.sidebarOpen = true; state.inspectorOpen = false; updateDrawers(); }
  function closeDrawers() { state.sidebarOpen = false; state.inspectorOpen = false; updateDrawers(); }
  function updateDrawers() {
    ui.sidebar.classList.toggle('is-open', state.sidebarOpen);
    ui.inspector.classList.toggle('is-open', state.inspectorOpen);
    ui.scrim.classList.toggle('is-visible', state.sidebarOpen || state.inspectorOpen);
    ui.scrim.setAttribute('aria-hidden', String(!(state.sidebarOpen || state.inspectorOpen)));
    const desktopInspectorShown = !window.matchMedia('(max-width: 1080px)').matches && !ui.shell.classList.contains('inspector-hidden');
    el('inspector-toggle').setAttribute('aria-pressed', String(state.inspectorOpen || desktopInspectorShown));
  }

  function toast(message, isError = false) {
    const box = document.createElement('div'); box.className = `toast${isError ? ' is-error' : ''}`; box.textContent = message; ui.toastRegion.append(box);
    window.setTimeout(() => { box.classList.add('is-leaving'); window.setTimeout(() => box.remove(), 220); }, 3000);
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(String(value || ''));
      toast('Copied to clipboard.');
    } catch (_) {
      const field = document.createElement('textarea'); field.value = String(value || ''); field.setAttribute('readonly', '');
      field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select();
      const copied = document.execCommand('copy'); field.remove(); toast(copied ? 'Copied to clipboard.' : 'Clipboard access was unavailable.', !copied);
    }
  }

  function resizeQuestion() {
    ui.question.style.height = 'auto';
    ui.question.style.height = `${Math.min(ui.question.scrollHeight, 120)}px`;
  }

  function setupCanvas() {
    const canvas = el('pitch-canvas'); const wrap = el('pitch-art-wrap'); const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rng = mulberry32(0xF1FA26);
    const strokes = Array.from({ length: 150 }, () => ({
      x: rng(), y: rng(), len: 2 + rng() * 7, rise: 2 + rng() * 5, phase: rng() * Math.PI * 2, alpha: .08 + rng() * .14,
    }));
    let width = 0, height = 0, visible = true, raf = 0, lastFrame = 0, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resize = () => {
      const rect = wrap.getBoundingClientRect(); width = rect.width; height = rect.height;
      if (!width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(0);
    };
    const draw = (time) => {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);
      const pitch = { x: width * .17, y: height * .09, w: width * .66, h: height * .7 };
      ctx.save(); ctx.translate(pitch.x, pitch.y); ctx.strokeStyle = 'rgba(89, 122, 68, .36)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(0, 0, pitch.w, pitch.h, 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pitch.w / 2, 0); ctx.lineTo(pitch.w / 2, pitch.h); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(pitch.w / 2, pitch.h / 2, pitch.h * .16, pitch.h * .16, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(pitch.w / 2, pitch.h / 2, 2, 0, Math.PI * 2); ctx.fillStyle = 'rgba(89, 122, 68, .52)'; ctx.fill();
      ctx.strokeRect(0, pitch.h * .23, pitch.w * .15, pitch.h * .54); ctx.strokeRect(pitch.w * .85, pitch.h * .23, pitch.w * .15, pitch.h * .54);
      ctx.strokeRect(0, pitch.h * .38, pitch.w * .06, pitch.h * .24); ctx.strokeRect(pitch.w * .94, pitch.h * .38, pitch.w * .06, pitch.h * .24);
      ctx.restore();
      const phase = reduced ? 0 : Math.sin(time / 2500) * 1.3;
      for (const blade of strokes) {
        const x = blade.x * width, y = blade.y * height;
        ctx.beginPath(); ctx.moveTo(x, y);
        const sway = reduced ? 0 : Math.sin(time / 1000 + blade.phase) * 1.7;
        ctx.quadraticCurveTo(x + sway + phase, y - blade.rise * .55, x + sway, y - blade.rise);
        ctx.strokeStyle = `rgba(94, 122, 63, ${blade.alpha})`; ctx.lineWidth = blade.len > 7 ? 1 : .7; ctx.stroke();
      }
      ctx.beginPath(); ctx.ellipse(width * .72, height * .68, 4, 2.1, -.2, 0, Math.PI * 2); ctx.fillStyle = 'rgba(194, 215, 94, .7)'; ctx.fill();
    };
    const loop = (now) => {
      raf = 0;
      if (!visible || document.hidden || reduced) { draw(0); return; }
      const dt = Math.min(64, now - lastFrame); lastFrame = now;
      if (dt > 0) draw(now);
      raf = requestAnimationFrame(loop);
    };
    const start = () => { if (reduced || !visible || document.hidden || raf) { if (reduced) draw(0); return; } lastFrame = performance.now(); raf = requestAnimationFrame(loop); };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; draw(0); };
    const observer = new IntersectionObserver((entries) => { visible = entries[0]?.isIntersecting ?? true; if (visible) start(); else stop(); });
    observer.observe(wrap);
    const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(wrap);
    document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', (event) => { reduced = event.matches; reduced ? stop() : start(); });
    resize(); start();
  }

  function mulberry32(seed) {
    let value = seed | 0;
    return () => {
      value = (value + 0x6D2B79F5) | 0;
      let t = Math.imul(value ^ (value >>> 15), 1 | value);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function bindEvents() {
    ui.form.addEventListener('submit', submitQuestion);
    ui.question.addEventListener('input', resizeQuestion);
    ui.question.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitQuestion(); }
    });
    el('new-chat').addEventListener('click', createThread);
    el('menu-button').addEventListener('click', openSidebar);
    el('sidebar-close').addEventListener('click', closeDrawers);
    el('inspector-close').addEventListener('click', closeDrawers);
    el('inspector-toggle').addEventListener('click', toggleInspector);
    el('mobile-scrim').addEventListener('click', closeDrawers);
    document.querySelectorAll('[data-open-inspector]').forEach((button) => button.addEventListener('click', () => { setActiveTab(button.dataset.openInspector); openInspector(); }));
    document.querySelectorAll('.inspector-tab').forEach((button) => {
      button.addEventListener('click', () => setActiveTab(button.dataset.tab));
      button.addEventListener('keydown', (event) => {
        const tabs = [...document.querySelectorAll('.inspector-tab')];
        const current = tabs.indexOf(button);
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!offset) return;
        event.preventDefault();
        const next = tabs[(current + offset + tabs.length) % tabs.length];
        setActiveTab(next.dataset.tab); next.focus();
      });
    });
    el('refresh-status').addEventListener('click', refreshStatus);
    ui.entityForm.addEventListener('submit', searchEntities);
    ui.entitySearch.addEventListener('input', () => {
      window.clearTimeout(state.entityTimer);
      if (!ui.entitySearch.value.trim()) { ui.entityResults.hidden = true; return; }
      state.entityTimer = window.setTimeout(() => searchEntities(), 280);
    });
    ui.entitySearch.addEventListener('keydown', (event) => { if (event.key === 'Escape') { ui.entitySearch.value = ''; ui.entityResults.hidden = true; } });
    el('zoom-in').addEventListener('click', () => graphZoom(1.18));
    el('zoom-out').addEventListener('click', () => graphZoom(.84));
    el('zoom-reset').addEventListener('click', resetGraphView);
    ui.graphViewport.addEventListener('wheel', handleGraphWheel, { passive: false });
    ui.graphViewport.addEventListener('pointerdown', handleGraphPointerDown);
    ui.graphViewport.addEventListener('pointermove', handleGraphPointerMove);
    ui.graphViewport.addEventListener('pointerup', handleGraphPointerUp);
    ui.graphViewport.addEventListener('pointercancel', handleGraphPointerUp);
    ui.graphViewport.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 28 : 13;
      if (event.key === '+' || event.key === '=') graphZoom(1.1);
      else if (event.key === '-') graphZoom(.9);
      else if (event.key === '0') resetGraphView();
      else if (event.key === 'ArrowLeft') state.graphTransform.x += step;
      else if (event.key === 'ArrowRight') state.graphTransform.x -= step;
      else if (event.key === 'ArrowUp') state.graphTransform.y += step;
      else if (event.key === 'ArrowDown') state.graphTransform.y -= step;
      else return;
      event.preventDefault(); applyGraphTransform();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { closeDrawers(); ui.entityResults.hidden = true; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); createThread(); }
    });
    window.addEventListener('resize', () => { if (window.matchMedia('(min-width: 1081px)').matches) closeDrawers(); });
  }

  function init() {
    if (state.threads.length) {
      state.currentThreadId = state.threads[0].id;
      const result = [...state.threads[0].turns].reverse().find((turn) => turn.result)?.result;
      if (result) { state.activeResult = result; state.graph = normalizeGraph(result.graph); state.graphReady = true; renderEvidence(result.evidence || []); }
      else emptyEvidence();
    } else {
      const thread = { id: `s-${Date.now().toString(36)}`, title: 'New session', updatedAt: Date.now(), turns: [] };
      state.threads.unshift(thread); state.currentThreadId = thread.id; emptyEvidence();
    }
    renderHistory(); renderSuggestions(); renderConversation(); renderGraph(); bindEvents(); setupCanvas();
    void refreshStatus();
  }

  init();
})();

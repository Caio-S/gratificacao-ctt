'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brl = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brDate = iso => iso ? iso.split('-').reverse().join('/') : '—';

/* =============== estado =============== */
const state = {
  view: 'dados',
  exibirNomes: false,
};

/* dados carregados do backend (funcionarios/pesagens/frotas/periodo) */
let DADOS = { funcionarios: [], pesagens: [], frotas: [], periodo: { inicio: null, fim: null }, diasBase: 25 };

async function api(path, opts) {
  const res = await fetch('/api' + path, opts);
  if (!res.ok) {
    let msg = 'Erro ' + res.status;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function carregarDados() {
  DADOS = await api('/dados');
  atualizarSubPeriodo();
}

function diasNoPeriodo(inicio, fim) {
  if (!inicio || !fim) return 0;
  const a = new Date(inicio), b = new Date(fim);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
function atualizarSubPeriodo() {
  const dias = diasNoPeriodo(DADOS.periodo.inicio, DADOS.periodo.fim);
  $('#subPeriodo').textContent = `Período de apuração: ${brDate(DADOS.periodo.inicio)} a ${brDate(DADOS.periodo.fim)} · ${dias} dias`;
}

/* =============== toast =============== */
let toastTimer = null;
function showToast(kind, msg) {
  const t = $('#toast');
  t.className = 'toast ' + kind + ' show';
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

/* =============== botao com spinner =============== */
function setBtnLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    if (btn.dataset.label === undefined) btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>' + btn.dataset.label;
  } else {
    btn.disabled = false;
    if (btn.dataset.label !== undefined) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
  }
}

/* =============== aviso (banner fixo no topo do corpo) =============== */
function showAviso(tipo, txt) {
  const el = $('#aviso');
  if (!txt) { el.style.display = 'none'; return; }
  el.className = 'aviso ' + tipo;
  el.textContent = txt;
  el.style.display = 'block';
}

/* =============== navegacao =============== */
function setView(v) {
  state.view = v;
  document.querySelectorAll('.aba').forEach(b => b.classList.toggle('ativa', b.dataset.v === v));
  showAviso(null);
  render();
}
document.querySelectorAll('.aba').forEach(b => b.onclick = () => setView(b.dataset.v));

$('#chkNomes').onchange = e => { state.exibirNomes = e.target.checked; render(); };

function render() {
  const render_fn = { dados: renderDados, parametros: renderParametros, calculo: renderCalculo,
    semanal: renderSemanal, diretoria: renderDiretoria, extrato: renderExtrato }[state.view];
  $('#main').innerHTML = render_fn ? render_fn() : '';
  const wire_fn = { dados: wireDados }[state.view];
  if (wire_fn) wire_fn();
}

function placeholder(titulo) {
  return `<div class="cartao"><h2>${esc(titulo)}</h2><div class="dica">Em construção — chega nas próximas fases.</div></div>`;
}
function renderParametros() { return placeholder('Parâmetros'); }
function renderCalculo() { return placeholder('Cálculo'); }
function renderSemanal() { return placeholder('Relatório semanal'); }
function renderDiretoria() { return placeholder('Painel diretoria'); }
function renderExtrato() { return placeholder('Extrato colaborador'); }

/* =============== aba: dados =============== */
function renderDados() {
  const d = DADOS;
  return `
    <div class="cartao">
      <h2>Período de apuração</h2>
      <div class="dica">Define o intervalo usado nos cálculos e nos dados de demonstração.</div>
      <div class="linha-form">
        <div class="campo"><label>Início</label><input type="date" id="f_inicio" value="${esc(d.periodo.inicio || '')}"></div>
        <div class="campo"><label>Fim</label><input type="date" id="f_fim" value="${esc(d.periodo.fim || '')}"></div>
        <div class="campo"><label>Dias-base (jornada completa)</label><input type="number" id="f_diasBase" min="1" max="31" value="${d.diasBase}"></div>
        <button class="btn" id="btnSalvarPeriodo">Salvar período</button>
      </div>
    </div>

    <div class="grade2">
      <div class="cartao">
        <h2>Funcionários / motoristas</h2>
        <div class="dica">Planilha com matrícula, nome, função, especialidade e departamento.</div>
        <label class="zona" id="zonaFuncionarios"><b>Clique para escolher o arquivo</b><br>ou arraste o .xlsx aqui
          <input type="file" id="f_funcionarios" accept=".xlsx" style="display:none">
        </label>
      </div>
      <div class="cartao">
        <h2>Disponibilidade de frotas</h2>
        <div class="dica">Relatório com colunas Frota, Descrição e % de disponibilidade.</div>
        <label class="zona" id="zonaFrotas"><b>Clique para escolher o arquivo</b><br>ou arraste o .xlsx aqui
          <input type="file" id="f_frotas" accept=".xlsx" style="display:none">
        </label>
      </div>
    </div>

    <div class="cartao">
      <h2>Pesagens / produção</h2>
      <div class="dica">Planilha com matrícula, data, peso, km/raio e frota de cada viagem.</div>
      <label class="zona" id="zonaPesagens"><b>Clique para escolher o arquivo</b><br>ou arraste o .xlsx aqui
        <input type="file" id="f_pesagens" accept=".xlsx" style="display:none">
      </label>
    </div>

    <div class="cartao">
      <h2>Resumo atual</h2>
      <div class="linha-form" style="margin-bottom:14px">
        <button class="btn sec" id="btnDemo">Carregar dados de demonstração</button>
        <button class="btn sec" id="btnLimpar" style="color:var(--vermelho);border-color:var(--vermelho)">Limpar tudo</button>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="rot">Funcionários</div><div class="val">${d.funcionarios.length}</div></div>
        <div class="kpi"><div class="rot">Pesagens</div><div class="val">${d.pesagens.length}</div></div>
        <div class="kpi"><div class="rot">Frotas (disponibilidade)</div><div class="val">${d.frotas.length}</div></div>
      </div>
    </div>`;
}
function wireDados() {
  $('#btnSalvarPeriodo').onclick = async () => {
    const btn = $('#btnSalvarPeriodo');
    const inicio = $('#f_inicio').value, fim = $('#f_fim').value, diasBase = +$('#f_diasBase').value || 25;
    if (!inicio || !fim) { showToast('erro', 'Informe início e fim do período.'); return; }
    setBtnLoading(btn, true);
    try {
      await api('/periodo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inicio, fim, diasBase }) });
      await carregarDados();
      showToast('ok', 'Período salvo.');
    } catch (e) { showToast('erro', e.message); }
    finally { setBtnLoading(btn, false); }
  };

  const upload = (inputId, endpoint, labelOk) => {
    $(inputId).onchange = async e => {
      const arquivo = e.target.files[0]; if (!arquivo) return;
      const fd = new FormData(); fd.append('arquivo', arquivo);
      try {
        const r = await api(endpoint, { method: 'POST', body: fd });
        await carregarDados();
        render();
        showToast('ok', labelOk(r));
      } catch (err) { showToast('erro', err.message); }
      e.target.value = '';
    };
  };
  upload('#f_funcionarios', '/import/funcionarios', r => `${r.total} funcionários importados de "${r.nomeArquivo}".`);
  upload('#f_frotas', '/import/frotas', r => `Disponibilidade importada: ${r.total} frotas.`);
  upload('#f_pesagens', '/import/pesagens', r => r.temKm
    ? `${r.total} pesagens importadas de "${r.nomeArquivo}".`
    : `${r.total} pesagens importadas, mas a coluna de km/raio não foi encontrada — km vai ficar zerado.`);

  $('#btnDemo').onclick = async () => {
    const btn = $('#btnDemo');
    setBtnLoading(btn, true);
    try {
      const r = await api('/seed', { method: 'POST' });
      await carregarDados();
      render();
      showToast('ok', `Dados de demonstração carregados: ${r.totalFuncionarios} funcionários e ${r.totalPesagens} pesagens.`);
    } catch (e) { showToast('erro', e.message); }
    finally { setBtnLoading(btn, false); }
  };

  $('#btnLimpar').onclick = async () => {
    if (!confirm('Limpar todos os dados importados (funcionários, pesagens e frotas)?')) return;
    const btn = $('#btnLimpar');
    setBtnLoading(btn, true);
    try {
      await api('/dados', { method: 'DELETE' });
      await carregarDados();
      render();
      showToast('ok', 'Dados limpos.');
    } catch (e) { showToast('erro', e.message); }
    finally { setBtnLoading(btn, false); }
  };
}

/* =============== boot =============== */
carregarDados().then(() => setView('dados'));

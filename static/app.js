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
  const fn = { dados: renderDados, parametros: renderParametros, calculo: renderCalculo,
    semanal: renderSemanal, diretoria: renderDiretoria, extrato: renderExtrato }[state.view];
  $('#main').innerHTML = fn ? fn() : '';
}

function placeholder(titulo) {
  return `<div class="cartao"><h2>${esc(titulo)}</h2><div class="dica">Em construção — chega nas próximas fases.</div></div>`;
}
function renderDados() { return placeholder('Dados'); }
function renderParametros() { return placeholder('Parâmetros'); }
function renderCalculo() { return placeholder('Cálculo'); }
function renderSemanal() { return placeholder('Relatório semanal'); }
function renderDiretoria() { return placeholder('Painel diretoria'); }
function renderExtrato() { return placeholder('Extrato colaborador'); }

/* =============== boot =============== */
setView('dados');

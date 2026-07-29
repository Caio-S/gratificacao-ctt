'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brl = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const numBR = (n, casas = 2) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const norm = s => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();
const brDate = iso => iso ? iso.split('-').reverse().join('/') : '—';
const dataCurta = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
/* teto cobrado do colaborador: prorata dos dias que ele pegou do período (quem
   trabalhou o período inteiro tem tetoEfetivo igual ao teto nominal do nível) */
const tetoDe = k => k.tetoEfetivo ?? k.teto;
/* true quando o colaborador nao pegou o periodo inteiro (admitido no meio) e
   por isso responde por uma fracao do teto do nivel */
const tetoParcial = k => tetoDe(k) < k.teto;
function tempoRelativo(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.round(h / 24);
  return `há ${d} dia${d > 1 ? 's' : ''}`;
}

/* =============== estado =============== */
const state = {
  view: 'dados',
  exibirNomes: false,
  extratoMat: null,
  extratoSemanaAberta: null,
  /* null = extrato do periodo aberto; com a chave de um periodo fechado, a
     mesma tela roda em cima do snapshot congelado daquele mes */
  extratoFechamento: null,
  ajusteModalMat: null,
  filtroAprovStatus: 'TODOS',
  /* cada aba com filtro proprio tem seu objeto isolado — nao ha estado de
     filtro global compartilhado entre abas (evita o painel da diretoria, ou
     qualquer outra aba, herdar o filtro aplicado em outra) */
  /* buscasFixadas: colaboradores "presos" no filtro (Enter na busca) — a busca
     que esta sendo digitada soma com eles, entao da pra ir juntando gente sem
     perder quem ja estava filtrado */
  filtroCalculo: { busca: '', buscasFixadas: [], apenasComProducao: true, especialidade: 'TODOS', departamento: 'TODOS', detalheAberto: null },
  filtroSemanal: { semana: 'TODAS', departamento: 'TODOS' },
  filtroDiretoria: { especialidade: 'TODOS', departamento: 'TODOS' },
  /* soComValor liga por padrao: a aprovacao so faz sentido pra quem tem valor
     a pagar — sem isso a lista vem com centenas de linhas zeradas */
  filtroAprovacoes: { busca: '', especialidade: 'TODOS', departamento: 'TODOS', soComAjuste: false, soComValor: true },
  filtroHistorico: { chave: null, busca: '', especialidade: 'TODOS', departamento: 'TODOS' },
  extratoRelatorioModalAberto: false,
  extratoRelatorioIntervalo: null,
  faltasModalMat: null,
};

/* dados carregados do backend (funcionarios/pesagens/frotas/periodo) */
let DADOS = { funcionarios: [], pesagens: [], frotas: [], periodo: { inicio: null, fim: null }, diasBase: 25, jornadaResumo: { matriculas: 0, registros: 0 } };
let PARAMS = null;
let CALC = null;
let USUARIOS_LISTA = [];
let GRATIF_APROVACOES = {};
/* periodos ja fechados (so os totais — o detalhe por colaborador fica guardado
   no backend e sera a base da tela de acompanhamento por mes) */
let FECHAMENTOS = [];
/* snapshot do periodo fechado que esta aberto na tela de Historico */
let FECHAMENTO_DETALHE = null;

const chavePeriodo = p => `${p.inicio}_${p.fim}`;
const rotuloPeriodo = p => `${brDate(p.inicio)} a ${brDate(p.fim)}`;

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

/* =============== modal de progresso de upload =============== */
/* fica pendurado no body (e nao no #main) pra sobreviver aos render() que
   acontecem durante o envio */
const tamanhoBR = b => b >= 1048576 ? `${numBR(b / 1048576, 1)} MB` : `${numBR(b / 1024, 0)} KB`;

function abrirModalProgresso(titulo, arquivo) {
  fecharModalProgresso();
  const ov = document.createElement('div');
  ov.className = 'modal-ov no-print';
  ov.id = 'progressoOv';
  ov.innerHTML = `
    <div class="modal-box" style="max-width:460px">
      <h3>${esc(titulo)}</h3>
      <div class="dica" style="margin:4px 0 0">${esc(arquivo.name)} · ${tamanhoBR(arquivo.size)}</div>
      <div class="barra-prog"><i id="progBarra"></i></div>
      <div class="linha-prog"><span id="progTexto">Preparando envio…</span><span class="mono" id="progPct"></span></div>
    </div>`;
  document.body.appendChild(ov);
}

function atualizarProgresso({ pct, texto, indeterminada }) {
  const barra = $('#progBarra'), txt = $('#progTexto'), lbl = $('#progPct');
  if (!barra) return;
  barra.classList.toggle('indeterminada', !!indeterminada);
  if (!indeterminada && pct != null) barra.style.width = pct + '%';
  if (texto) txt.textContent = texto;
  lbl.textContent = indeterminada || pct == null ? '' : pct + '%';
}

function fecharModalProgresso() {
  const ov = $('#progressoOv');
  if (ov) ov.remove();
}

/* envia o arquivo por XHR (o fetch nao expoe progresso de upload) e vai
   alimentando a barra: % enquanto sobe, indeterminada enquanto o servidor
   processa a planilha */
function enviarArquivoComProgresso(endpoint, arquivo) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + endpoint);
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const pct = Math.round(100 * e.loaded / e.total);
      atualizarProgresso({ pct, texto: `Enviando… ${tamanhoBR(e.loaded)} de ${tamanhoBR(e.total)}` });
    };
    xhr.upload.onload = () => atualizarProgresso({ indeterminada: true, texto: 'Arquivo recebido — processando a planilha…' });
    xhr.onload = () => {
      let corpo = null;
      try { corpo = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(corpo);
      else reject(new Error((corpo && corpo.error) || `Erro ${xhr.status} ao enviar o arquivo.`));
    };
    xhr.onerror = () => reject(new Error('Falha de conexão ao enviar o arquivo.'));
    xhr.ontimeout = () => reject(new Error('O envio demorou demais e foi interrompido.'));
    xhr.send((() => { const fd = new FormData(); fd.append('arquivo', arquivo); return fd; })());
  });
}

async function carregarDados() {
  DADOS = await api('/dados');
  atualizarSubPeriodo();
}

async function carregarParametros() {
  PARAMS = await api('/parametros');
}

async function carregarCalculo() {
  CALC = await api('/calculo');
}

async function carregarAprovacoesGratificacao() {
  GRATIF_APROVACOES = await api('/gratificacoes/aprovacoes');
}

async function carregarUsuarios() {
  USUARIOS_LISTA = await api('/usuarios');
}

async function carregarFechamentos() {
  FECHAMENTOS = await api('/fechamentos');
}

async function carregarFechamentoDetalhe(chave) {
  if (!chave) { FECHAMENTO_DETALHE = null; return; }
  if (FECHAMENTO_DETALHE && chavePeriodo(FECHAMENTO_DETALHE.periodo) === chave) return;
  const [inicio, fim] = chave.split('_');
  FECHAMENTO_DETALHE = await api(`/fechamentos/${inicio}/${fim}`);
}

function renderPreservandoFoco() {
  const ativo = document.activeElement;
  const id = ativo && ativo.id;
  const selStart = ativo && typeof ativo.selectionStart === 'number' ? ativo.selectionStart : null;
  const selEnd = ativo && typeof ativo.selectionEnd === 'number' ? ativo.selectionEnd : null;
  render();
  if (id) {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      if (selStart !== null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selEnd); } catch (_) {} }
    }
  }
}

/* render() recria o #main inteiro, o que joga a tabela de calculo de volta pro
   topo. Aqui a gente guarda onde a pagina estava, roda o render e reposiciona a
   tabela na linha do colaborador mexido — buscando pela matricula, porque a
   lista e ordenada por gratificacao e a linha pode ter mudado de lugar depois
   de um ajuste. */
function renderMantendoLinha(mat) {
  const scrollPagina = window.scrollY;
  const caixaAntes = $('.tabela-calc');
  const scrollTabela = caixaAntes ? caixaAntes.scrollTop : 0;
  render();
  window.scrollTo(0, scrollPagina);
  const caixa = $('.tabela-calc');
  if (!caixa) return;
  caixa.scrollTop = scrollTabela;
  if (!mat) return;
  const linha = caixa.querySelector(`tr[data-mat="${CSS.escape(String(mat))}"]`);
  if (!linha) return;
  const rLinha = linha.getBoundingClientRect(), rCaixa = caixa.getBoundingClientRect();
  const fora = rLinha.top < rCaixa.top || rLinha.bottom > rCaixa.bottom;
  if (fora) caixa.scrollTop += (rLinha.top - rCaixa.top) - (caixa.clientHeight - rLinha.height) / 2;
  linha.classList.add('linha-destaque');
  setTimeout(() => linha.classList.remove('linha-destaque'), 2200);
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
const VIEWS_QUE_USAM_CALCULO = new Set(['calculo', 'semanal', 'diretoria', 'extrato', 'aprovacoes']);
async function setView(v) {
  state.view = v;
  document.querySelectorAll('.aba').forEach(b => b.classList.toggle('ativa', b.dataset.v === v));
  showAviso(null);
  $('#corpo').classList.toggle('largo', v === 'calculo');
  /* no extrato de um periodo fechado tudo vem do snapshot — nao precisa (nem
     deve) rodar o calculo do periodo aberto */
  const extratoCongelado = v === 'extrato' && state.extratoFechamento;
  if (VIEWS_QUE_USAM_CALCULO.has(v) && !extratoCongelado) {
    $('#main').innerHTML = '<div class="cartao"><div class="dica">Calculando…</div></div>';
    try { await carregarCalculo(); } catch (e) { showAviso('erro', 'Falha ao calcular: ' + e.message); }
  }
  if (v === 'extrato') {
    try {
      if (!FECHAMENTOS.length) await carregarFechamentos();
      if (state.extratoFechamento) await carregarFechamentoDetalhe(state.extratoFechamento);
    } catch (e) { showAviso('erro', 'Falha ao carregar período fechado: ' + e.message); }
  }
  if (v === 'aprovacoes') {
    try { await carregarAprovacoesGratificacao(); } catch (e) { showAviso('erro', 'Falha ao carregar aprovações: ' + e.message); }
  }
  if (v === 'usuarios') {
    try { await carregarUsuarios(); } catch (e) { showAviso('erro', 'Falha ao carregar usuários: ' + e.message); }
  }
  if (v === 'dados' || v === 'historico') {
    try { await carregarFechamentos(); } catch (e) { showAviso('erro', 'Falha ao carregar fechamentos: ' + e.message); }
  }
  if (v === 'historico') {
    const f = state.filtroHistorico;
    if (!f.chave && FECHAMENTOS.length) f.chave = chavePeriodo(FECHAMENTOS[0].periodo);
    if (f.chave) {
      $('#main').innerHTML = '<div class="cartao"><div class="dica">Carregando período…</div></div>';
      try { await carregarFechamentoDetalhe(f.chave); } catch (e) { showAviso('erro', 'Falha ao carregar o período: ' + e.message); }
    }
  }
  render();
}
document.querySelectorAll('.aba').forEach(b => b.onclick = () => setView(b.dataset.v));

$('#chkNomes').onchange = e => { state.exibirNomes = e.target.checked; render(); };

function render() {
  const render_fn = { dados: renderDados, parametros: renderParametros, calculo: renderCalculo,
    semanal: renderSemanal, diretoria: renderDiretoria, extrato: renderExtrato,
    historico: renderHistorico, aprovacoes: renderAprovacoes, usuarios: renderUsuarios }[state.view];
  $('#main').innerHTML = render_fn ? render_fn() : '';
  const wire_fn = { dados: wireDados, parametros: wireParametros, calculo: wireCalculo, semanal: wireSemanal, diretoria: wireDiretoria, extrato: wireExtrato,
    historico: wireHistorico, aprovacoes: wireAprovacoes, usuarios: wireUsuarios }[state.view];
  if (wire_fn) wire_fn();
}

function placeholder(titulo) {
  return `<div class="cartao"><h2>${esc(titulo)}</h2><div class="dica">Em construção — chega nas próximas fases.</div></div>`;
}
/* =============== aba: relatorio semanal =============== */
/* De onde o extrato tira os dados: do periodo aberto (calculo ao vivo) ou do
   snapshot de um periodo ja fechado. As duas telas usam o MESMO render — muda
   so a origem de lista/periodo/parametros/dias-base. */
function contextoExtrato() {
  const snap = FECHAMENTO_DETALHE;
  if (state.extratoFechamento && snap && chavePeriodo(snap.periodo) === state.extratoFechamento) {
    return {
      congelado: true,
      lista: snap.colaboradores,
      periodo: snap.periodo,
      nSem: snap.nSem || 0,
      diasBase: snap.diasBase,
      parametros: snap.parametros || PARAMS,
      frotas: [],
    };
  }
  return {
    congelado: false,
    lista: CALC ? CALC.lista : [],
    periodo: DADOS.periodo,
    nSem: CALC ? CALC.nSem : 0,
    diasBase: DADOS.diasBase,
    parametros: PARAMS,
    frotas: DADOS.frotas || [],
  };
}

function semanasDoPeriodo(ctx) {
  const c = ctx || { periodo: DADOS.periodo, nSem: CALC ? CALC.nSem : 0 };
  const inicio = new Date(c.periodo.inicio + 'T00:00:00');
  const fim = new Date(c.periodo.fim + 'T00:00:00');
  const semanas = [];
  for (let idx = 0; idx < c.nSem; idx++) {
    const ini = new Date(inicio.getTime() + idx * 7 * 86400000);
    const fimSem = new Date(Math.min(fim.getTime(), ini.getTime() + 6 * 86400000));
    semanas.push({ idx, rotulo: `Sem ${idx + 1}`, faixa: `${dataCurta(ini)}–${dataCurta(fimSem)}` });
  }
  return semanas;
}

function exportarCsvSemanal() {
  const yt = semanasDoPeriodo();
  const cabecalho = ['Matrícula', ...(state.exibirNomes ? ['Nome'] : []), 'Departamento', 'Especialidade',
    ...yt.map(s => `${s.rotulo} R$`), 'Ton total', 'Viagens', 'Salário base R$', 'Gratificação R$', 'Teto gratif. R$', '% Atingido', 'Total a receber R$'];
  const linhas = [cabecalho];
  for (const k of (CALC ? CALC.lista : [])) {
    linhas.push([k.mat, ...(state.exibirNomes ? [k.nome] : []), k.departamento || 'Não informado', k.espec,
      ...yt.map(s => numBR(k.semanas[String(s.idx)]?.valor || 0)), numBR(k.ton), k.viagens, numBR(k.sal), numBR(k.gratif), numBR(tetoDe(k)), numBR(k.atingPct * 100, 1) + '%', numBR(k.totalReceber)]);
  }
  const csv = linhas.map(l => l.map(v => `"${v}"`).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gratificacao_semanal_${DADOS.periodo.inicio}_a_${DADOS.periodo.fim}.csv`;
  a.click();
}

function renderSemanal() {
  if (!CALC) return placeholder('Relatório semanal');
  const f = state.filtroSemanal;
  const todasSemanas = semanasDoPeriodo();
  const semanasVisiveis = f.semana === 'TODAS' ? todasSemanas : todasSemanas.filter(s => String(s.idx) === f.semana);
  const departamentos = [...new Set(CALC.lista.map(k => k.departamento || 'Não informado'))].sort();
  const lista = CALC.lista.filter(k => k.viagens > 0 && (f.departamento === 'TODOS' || (k.departamento || 'Não informado') === f.departamento));

  const linhas = lista.map(k => {
    const metaSemanal = CALC.nSem ? tetoDe(k) / CALC.nSem : 0;
    const pctGratif = k.atingPct * 100;
    return `
      <tr>
        <td class="mono">${esc(k.mat)}</td>
        <td>${state.exibirNomes ? esc(k.nome) : `Colaborador ${esc(k.mat)}`}</td>
        <td class="tag-sem">${esc(k.departamento || 'Não informado')}</td>
        <td>${badgeEspec(k.espec)}</td>
        ${semanasVisiveis.map(s => {
          const sem = k.semanas[String(s.idx)];
          if (!sem) return '<td class="num"><span style="color:var(--muted)">—</span></td>';
          const pct = metaSemanal ? sem.valor / metaSemanal * 100 : 0;
          return `<td class="num"><span style="font-weight:600${pct > 100 ? ';color:var(--ambar)' : ''}">${numBR(pct, 1)}%</span><div class="tag-sem">${numBR(sem.ton, 0)} t</div></td>`;
        }).join('')}
        <td class="num">${numBR(k.ton, 0)}</td>
        <td class="num"><span style="font-weight:600${pctGratif > 100 ? ';color:var(--ambar)' : ''}">${numBR(pctGratif, 1)}%</span><div class="tag-sem">${numBR(k.ton, 0)} t</div></td>
      </tr>`;
  }).join('');

  return `
    <div class="cartao">
      <div class="linha-form" style="justify-content:space-between">
        <div>
          <h2 style="margin:0">Acompanhamento semanal</h2>
          <div class="dica" style="margin:4px 0 0">% da gratificação de cada semana isolada (não acumulado), em relação à meta daquela semana (teto do período ÷ número de semanas) (${brDate(DADOS.periodo.inicio)} a ${brDate(DADOS.periodo.fim)}).</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <select id="semSemana">
            <option value="TODAS" ${f.semana === 'TODAS' ? 'selected' : ''}>Todas as semanas</option>
            ${todasSemanas.map(s => `<option value="${s.idx}" ${f.semana === String(s.idx) ? 'selected' : ''}>${s.rotulo} · ${s.faixa}</option>`).join('')}
          </select>
          <select id="semDepto">
            <option value="TODOS" ${f.departamento === 'TODOS' ? 'selected' : ''}>Todos os departamentos</option>
            ${departamentos.map(d => `<option value="${esc(d)}" ${f.departamento === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
          </select>
          <button class="btn" id="btnExportarCsvSemanal">Exportar CSV</button>
          <button class="btn no-print" id="btnExportarSemanalPdf">Exportar PDF</button>
        </div>
      </div>
      <div class="scroll-x">
        <table>
          <thead><tr>
            <th>Mat.</th><th>Colaborador</th><th>Departamento</th><th>Espec.</th>
            ${semanasVisiveis.map(s => `<th class="num">${s.rotulo}<div class="tag-sem">${s.faixa}</div></th>`).join('')}
            <th class="num">Ton acum.</th><th class="num">% Gratificação</th>
          </tr></thead>
          <tbody>${linhas || `<tr><td colspan="${6 + semanasVisiveis.length}" style="text-align:center;padding:24px;color:var(--muted)">Sem dados no período.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}
function wireSemanal() {
  const f = state.filtroSemanal;
  $('#semSemana').onchange = e => { f.semana = e.target.value; render(); };
  $('#semDepto').onchange = e => { f.departamento = e.target.value; render(); };
  $('#btnExportarCsvSemanal').onclick = exportarCsvSemanal;
  $('#btnExportarSemanalPdf').onclick = () => window.print();
}
/* =============== aba: painel diretoria =============== */
function resumoDiretoria() {
  const f = state.filtroDiretoria;
  const lista = (CALC ? CALC.lista : []).filter(k =>
    k.viagens > 0 &&
    (f.especialidade === 'TODOS' || k.espec === f.especialidade) &&
    (f.departamento === 'TODOS' || (k.departamento || 'Não informado') === f.departamento)
  );
  const semanas = semanasDoPeriodo().map(s => ({ ...s, valor: 0, ton: 0 }));
  const porEspec = {};
  const tot = { n: 0, ton: 0, viagens: 0, gratif: 0, sal: 0, totalReceber: 0 };
  let somaTeto = 0, abaixo = [], acimaTeto = 0;
  for (const k of lista) {
    tot.n++; tot.ton += k.ton; tot.viagens += k.viagens; tot.gratif += k.gratif; tot.sal += k.sal; tot.totalReceber += k.totalReceber;
    somaTeto += tetoDe(k) || 0;
    for (const s of semanas) {
      const sem = k.semanas[String(s.idx)];
      if (sem) { s.valor += sem.valor; s.ton += sem.ton; }
    }
    porEspec[k.espec] || (porEspec[k.espec] = { ton: 0, n: 0, gratif: 0, viagens: 0 });
    const pe = porEspec[k.espec];
    pe.ton += k.ton; pe.n++; pe.gratif += k.gratif; pe.viagens += k.viagens;
    if (tetoDe(k)) {
      if (k.atingPct < 0.7) abaixo.push(k);
      if (k.atingPct > 1) acimaTeto++;
    }
  }
  const maxSem = Math.max(1, ...semanas.map(s => s.valor));
  return {
    lista, porSem: semanas, porEspec, maxSem,
    atingMedio: somaTeto ? tot.gratif / somaTeto : 0,
    gratifMedia: tot.n ? tot.gratif / tot.n : 0,
    nProd: tot.n, abaixo, acimaTeto, ...tot,
  };
}

function renderDiretoria() {
  if (!CALC) return placeholder('Painel diretoria');
  const f = state.filtroDiretoria;
  const xe = resumoDiretoria();
  const top10 = xe.lista.slice(0, 10);
  const maxGratifTop10 = Math.max(1, ...top10.map(k => k.gratif));
  const departamentos = [...new Set((CALC.lista || []).map(k => k.departamento || 'Não informado'))].sort();
  const especEntries = Object.entries(xe.porEspec).sort((a, b) => b[1].gratif - a[1].gratif);

  return `
    <div class="hero-dir">
      <div>
        <h2>Resumo executivo — Gratificação CTT</h2>
        <div class="per">Motoristas e operadores · ${brDate(DADOS.periodo.inicio)} a ${brDate(DADOS.periodo.fim)} · ${xe.n} colaboradores · <span class="mono">${xe.viagens.toLocaleString('pt-BR')}</span> pesagens</div>
        <div style="margin-top:10px"><span class="sigilo">🔒 Sem identificação nominal — referência por matrícula</span></div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <select id="dirEspec" class="no-print">
            <option value="TODOS" ${f.especialidade === 'TODOS' ? 'selected' : ''}>Todas as especialidades</option>
            <option value="CAMINHAO" ${f.especialidade === 'CAMINHAO' ? 'selected' : ''}>Caminhão canavieiro</option>
            <option value="BATE-VOLTA" ${f.especialidade === 'BATE-VOLTA' ? 'selected' : ''}>Bate e volta</option>
            <option value="COLHEDORA" ${f.especialidade === 'COLHEDORA' ? 'selected' : ''}>Operador colhedora</option>
            <option value="TRANSBORDO" ${f.especialidade === 'TRANSBORDO' ? 'selected' : ''}>Operador transbordo</option>
          </select>
          <select id="dirDepto" class="no-print">
            <option value="TODOS" ${f.departamento === 'TODOS' ? 'selected' : ''}>Todos os departamentos</option>
            ${departamentos.map(d => `<option value="${esc(d)}" ${f.departamento === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:28px;align-items:center">
        <div class="destaque"><div class="v">${numBR(xe.ton / 1000, 1)} mil t</div><div class="r">Cana transportada</div></div>
        <div class="destaque"><div class="v">${brl(xe.gratif).replace(',00', '')}</div><div class="r">Gratificação apurada</div></div>
        <button class="btn no-print" style="background:#F5C56B;color:#123D27" id="btnImprimirDiretoria">Imprimir / PDF</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="rot">Gratificação média (R$)</div><div class="val">${numBR(xe.gratifMedia, 0)}</div><div class="det">por colaborador com produção (${xe.nProd})</div></div>
      <div class="kpi"><div class="rot">Atingimento médio do teto</div><div class="val">${numBR(xe.atingMedio * 100, 1)}%</div><div class="det">gratificação ÷ teto do nível</div></div>
      <div class="kpi"><div class="rot">Acima de 100% do teto</div><div class="val" style="color:var(--ambar)">${xe.acimaTeto}</div><div class="det">colaboradores acima do teto</div></div>
      <div class="kpi"><div class="rot">Custo médio / tonelada</div><div class="val">${xe.ton ? numBR(xe.gratif / xe.ton, 3) : '—'}</div><div class="det">R$ de gratificação por t</div></div>
      <div class="kpi"><div class="rot">Salário + gratificação</div><div class="val">${numBR(xe.totalReceber / 1000, 0)}k</div><div class="det">folha estimada sem HE/DSR</div></div>
      <div class="kpi"><div class="rot">Abaixo de 70% da meta</div><div class="val" style="color:${xe.abaixo.length ? 'var(--vermelho)' : 'var(--verde)'}">${xe.abaixo.length}</div><div class="det">colaboradores em atenção</div></div>
    </div>

    <div class="grade2">
      <div class="cartao">
        <h2>Evolução semanal da produção</h2>
        <div class="dica">Gratificação de produção gerada por semana do período (R$ e toneladas).</div>
        <div class="colunas">
          ${xe.porSem.map(s => `
            <div class="col">
              <div class="v">${numBR(s.valor / 1000, 1)}k</div>
              <i style="height:${xe.maxSem ? s.valor / xe.maxSem * 100 : 0}%"></i>
              <div class="lab">${s.rotulo}<br>${numBR(s.ton / 1000, 1)} mil t</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="cartao">
        <h2>Por especialidade</h2>
        <div class="dica">Gratificação total e volume por tipo de equipamento.</div>
        <table>
          <thead><tr><th>Especialidade</th><th class="num">Colab.</th><th class="num">Ton</th><th class="num">Viagens</th><th class="num">Gratif. (R$)</th><th class="num">R$/colab.</th></tr></thead>
          <tbody>${especEntries.map(([espec, v]) => `
            <tr><td>${ESPEC_LABEL[espec] || esc(espec)}</td><td class="num">${v.n}</td><td class="num">${numBR(v.ton, 0)}</td>
              <td class="num">${v.viagens.toLocaleString('pt-BR')}</td><td class="num" style="font-weight:600">${numBR(v.gratif, 0)}</td>
              <td class="num">${numBR(v.n ? v.gratif / v.n : 0, 0)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="cartao">
      <h2>Top 10 — maiores gratificações do período</h2>
      <div class="dica">Colaboradores referenciados apenas pela matrícula. Barra âmbar = passou de 100% do teto da gratificação.</div>
      ${top10.map(k => `
        <div class="gbar">
          <div class="grot"><b>${esc(k.mat)}</b> · ${ESPEC_LABEL[k.espec] || esc(k.espec)}</div>
          <div class="trilho"><i class="${k.atingPct > 1 ? 'ouro' : ''}" style="width:${k.gratif / maxGratifTop10 * 100}%"></i></div>
          <div class="valr">${brl(k.gratif)}</div>
        </div>`).join('')}
      ${!top10.length ? '<div style="color:var(--muted);padding:12px">Sem dados — importe as bases na aba Dados.</div>' : ''}
    </div>

    ${xe.abaixo.length > 0 ? `
    <div class="cartao">
      <h2>Pontos de atenção — abaixo de 70% do teto da gratificação</h2>
      <div class="scroll-x">
        <table>
          <thead><tr><th>Matrícula</th><th>Espec.</th><th class="num">Dias</th><th class="num">Viagens</th><th class="num">Ton</th><th class="num">Gratif. (R$)</th><th>% Atingido</th></tr></thead>
          <tbody>${[...xe.abaixo].sort((a, b) => a.atingPct - b.atingPct).slice(0, 15).map(k => `
            <tr>
              <td class="mono"><b>${esc(k.mat)}</b></td>
              <td>${badgeEspec(k.espec)}</td>
              <td class="num">${k.dias}</td>
              <td class="num">${k.viagens}</td>
              <td class="num">${numBR(k.ton, 0)}</td>
              <td class="num">${numBR(k.gratif)}</td>
              <td><div style="display:flex;align-items:center;gap:6px">
                <div class="barra" style="width:70px"><i style="width:${Math.min(100, k.atingPct * 100)}%;background:var(--vermelho)"></i></div>
                <span class="mono" style="font-size:11.5px">${numBR(k.atingPct * 100, 1)}%</span>
              </div></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}`;
}
function wireDiretoria() {
  const f = state.filtroDiretoria;
  $('#dirEspec').onchange = e => { f.especialidade = e.target.value; render(); };
  $('#dirDepto').onchange = e => { f.departamento = e.target.value; render(); };
  $('#btnImprimirDiretoria').onclick = () => window.print();
}
/* =============== aba: extrato colaborador =============== */
/* Rk/Ck: tabela de referencia de ton/dia por faixa de km (so informativa, nao
   editavel em Parametros — usada apenas na coluna "Ton/dia padrão" do detalhe
   diario do extrato). Portada fielmente do artefato original. */
const _TAXAS_TON_REF = [565.7, 485.7, 425.5, 378.5, 340.9, 310.1, 284.4, 262.7, 244, 227.8, 213.6, 201.1, 190, 180, 171, 162.9, 155.5, 148.8, 142.6, 136.9, 131.7, 126.8, 122.3, 118.1, 114.1];
const _TAXAS_TON_REF_BV = [1350, 981.8, 771.4, 635.3, 540, 469.6, 415.4, 372.4, 337.5, 308.6, 284.2, 263.4, 245.5, 229.8, 216, 203.8, 192.9, 183.1, 174.2, 166.2, 158.8, 152.1, 145.9, 140.3, 140.3];
const TABELA_TON_CANAVIEIRO = _TAXAS_TON_REF.map((v, i) => ({ ini: i * 5 + 1, fim: i * 5 + 5, ton: v }));
const TABELA_TON_BV = _TAXAS_TON_REF_BV.map((v, i) => ({ ini: i * 5 + 1, fim: i * 5 + 5, ton: v }));
function tonReferencia(km, tabelaNome) {
  const kmArred = Math.round(km);
  const tabela = tabelaNome === 'bv' ? TABELA_TON_BV : TABELA_TON_CANAVIEIRO;
  const banda = tabela.find(b => kmArred >= b.ini && kmArred <= b.fim);
  if (banda) return banda.ton;
  return kmArred > tabela[tabela.length - 1].fim ? tabela[tabela.length - 1].ton : tabela[0].ton;
}

function seletorPeriodoExtrato() {
  return `
    <div class="linha-form no-print">
      <div class="campo">
        <label>Período</label>
        <select id="extratoPeriodo" style="min-width:200px">
          <option value="">Período aberto — ${esc(rotuloPeriodo(DADOS.periodo))}</option>
          ${FECHAMENTOS.map(x => `<option value="${esc(chavePeriodo(x.periodo))}" ${chavePeriodo(x.periodo) === state.extratoFechamento ? 'selected' : ''}>Fechado — ${esc(rotuloPeriodo(x.periodo))}</option>`).join('')}
        </select>
      </div>
      ${state.extratoFechamento ? '<button class="btn sec" id="btnVoltarHistorico">← Voltar ao histórico</button>' : ''}
    </div>`;
}

function renderExtrato() {
  const ctx = contextoExtrato();
  if (!ctx.congelado && !CALC) return placeholder('Extrato colaborador');
  const P = ctx.parametros;
  const pe = ctx.lista.filter(k => k.viagens > 0);
  const me = pe.find(k => String(k.mat) === String(state.extratoMat)) || pe[0];
  if (!me) {
    return `${seletorPeriodoExtrato(ctx)}<div class="cartao"><h2>Extrato do colaborador</h2><div class="dica">${ctx.congelado ? 'Nenhum colaborador com produção registrada neste período fechado.' : 'Sem dados — importe as bases ou carregue a demonstração na aba Dados.'}</div></div>`;
  }
  const especCfg = (P.especialidades || []).find(e => e.chave === me.espec) || {};
  const tabelaNome = especCfg.tabela || 'canavieiro';
  const referenciaDia = km => me.espec === 'COLHEDORA' ? P.tetoColhedora.metaDia
    : me.espec === 'TRANSBORDO' ? P.tetoTransbordo.metaDia
    : tonReferencia(km, tabelaNome);
  if (state.extratoRelatorioIntervalo) {
    return renderRelatorioDetalhado(me, referenciaDia);
  }
  const especLabelFull = { CAMINHAO: 'Caminhão canavieiro', 'BATE-VOLTA': 'Caminhão bate e volta', COLHEDORA: 'Colhedora de cana', TRANSBORDO: 'Trator transbordo' }[me.espec] || me.espec;
  const producaoBruta = me['prodR$'];
  const faltaTeto = Math.max(0, tetoDe(me) - me.gratif);
  const semanas = semanasDoPeriodo(ctx);
  const semanasDoColab = me.semanas || {};
  const maxSemValor = Math.max(1, ...semanas.map(s => (semanasDoColab[String(s.idx)] || {}).valor || 0));
  let acumulado = 0;
  const semanasAcum = semanas.map(s => {
    const w = semanasDoColab[String(s.idx)];
    acumulado += w ? w.valor : 0;
    return { ...s, w, acum: acumulado };
  });
  const pctGratifDoTotal = me.totalReceber > 0 ? me.gratif / me.totalReceber * 100 : 0;
  const diasBase = ctx.diasBase;

  const semanaAberta = semanasAcum.find(s => s.idx === state.extratoSemanaAberta);

  const modal = semanaAberta ? (() => {
    const diasEntries = Object.entries(semanaAberta.w.dias || {}).sort((a, b) => a[0] < b[0] ? -1 : 1);
    const totalW = semanaAberta.w;
    const linhasDias = diasEntries.map(([iso, d]) => {
      const raioMed = d.viagens ? d.km / d.viagens : 0;
      return `
        <tr>
          <td>${dataCurta(new Date(iso + 'T00:00:00'))}</td>
          <td class="num">${d.viagens}</td>
          <td class="num">${d.viagens ? numBR(raioMed, 0) : '—'}</td>
          <td class="num">${numBR(d.ton, 1)}</td>
          <td class="num">${d.ton ? numBR(d.valor / d.ton, 4) : '—'}</td>
          <td class="num" style="font-weight:600">${numBR(d.valor)}</td>
          <td class="num tag-sem">${d.viagens ? numBR(referenciaDia(raioMed), 0) : '—'}</td>
        </tr>`;
    }).join('');
    const raioMedTotal = totalW.viagens ? totalW.km / totalW.viagens : 0;
    return `
      <div class="modal-ov no-print" id="extratoModalOv">
        <div class="modal-box largo" id="extratoModalBox">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <h3>Período de apuração: ${semanaAberta.faixa} · ${semanaAberta.rotulo}</h3>
            <button class="modal-fecha" id="extratoModalFechar">×</button>
          </div>
          <div class="dica">Detalhe diário de viagens, raio médio e toneladas carregadas na semana. Validação: R$/t unitário × toneladas = valor do dia. "Ton/dia padrão" é o valor esperado para o raio do dia, conforme a tabela de referência de precificação.</div>
          <div class="scroll-x">
            <table>
              <thead><tr><th>Dia</th><th class="num">Viagens</th><th class="num">Raio méd. (km)</th><th class="num">Toneladas</th><th class="num">R$/t unitário</th><th class="num">Valor (R$)</th><th class="num">Ton/dia padrão</th></tr></thead>
              <tbody>
                ${linhasDias}
                <tr style="font-weight:600;border-top:2px solid var(--verde)">
                  <td>Total</td>
                  <td class="num">${totalW.viagens}</td>
                  <td class="num">${totalW.viagens ? numBR(raioMedTotal, 0) : '—'}</td>
                  <td class="num">${numBR(totalW.ton, 1)}</td>
                  <td class="num">${totalW.ton ? numBR(totalW.valor / totalW.ton, 4) : '—'}</td>
                  <td class="num">${numBR(totalW.valor)}</td>
                  <td class="num tag-sem">${totalW.viagens ? numBR(referenciaDia(raioMedTotal), 0) : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  })() : '';

  return `
    <div class="linha-form no-print" style="justify-content:space-between">
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
        <div class="campo">
          <label>Período</label>
          <select id="extratoPeriodo" style="min-width:200px">
            <option value="">Período aberto — ${esc(rotuloPeriodo(DADOS.periodo))}</option>
            ${FECHAMENTOS.map(x => `<option value="${esc(chavePeriodo(x.periodo))}" ${chavePeriodo(x.periodo) === state.extratoFechamento ? 'selected' : ''}>Fechado — ${esc(rotuloPeriodo(x.periodo))}</option>`).join('')}
          </select>
        </div>
        <div class="campo">
          <label>Colaborador (matrícula)</label>
          <select id="extratoSelect" style="min-width:260px">
            ${pe.map(k => `<option value="${esc(k.mat)}" ${String(k.mat) === String(me.mat) ? 'selected' : ''}>${esc(k.mat)}${state.exibirNomes ? ' — ' + esc(k.nome) : ''} · ${ESPEC_LABEL[k.espec] || esc(k.espec)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        ${ctx.congelado ? '<button class="btn sec" id="btnVoltarHistorico">← Voltar ao histórico</button>' : ''}
        <button class="btn sec" id="btnRelatorioDetalhado">📅 Relatório detalhado</button>
        <button class="btn" id="btnImprimirExtrato">Imprimir extrato / PDF</button>
      </div>
    </div>
    ${ctx.congelado ? `<div class="aviso ok no-print">Período <b>fechado</b> em ${esc((FECHAMENTO_DETALHE.fechadoEm || '').slice(0, 10).split('-').reverse().join('/'))} por ${esc(FECHAMENTO_DETALHE.fechadoPor || '—')} — valores congelados, não mudam com importações novas.</div>` : ''}

    <div class="cartao">
      <div class="recibo-topo">
        <div>
          <div class="idc">Matrícula ${esc(me.mat)}</div>
          ${state.exibirNomes ? `<div style="font-weight:600;margin-top:2px">${esc(me.nome)}</div>` : ''}
          <div class="tag-sem" style="margin-top:4px">${esc(especLabelFull)}${me.funcao ? ' · ' + esc(me.funcao) : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:'Barlow Condensed';font-weight:700;font-size:20px;color:var(--verde-esc);text-transform:uppercase;letter-spacing:.6px">Extrato de gratificação</div>
          <div class="tag-sem">Período ${brDate(ctx.periodo.inicio)} a ${brDate(ctx.periodo.fim)}${me.dias != null ? ` · ${me.dias} de ${diasBase} dias trabalhados (base prorata)` : ''}</div>
        </div>
      </div>
      <div class="comp">
        <div class="bloco">
          <div class="r">Gratificação de produção</div>
          <div class="v">${brl(me.gratif)}</div>
          <div class="d">${numBR(me.ton, 1)} t em ${me.viagens} pesagens${me.kmMed ? ` · raio méd. ${numBR(me.kmMed, 0)} km` : ''}</div>
          <div class="d">${numBR(producaoBruta)} produzido${me.dias != null && me.dias < diasBase ? ` × ${me.dias}/${diasBase} dias` : ''}${P.aplicarTeto && producaoBruta > me.teto ? ' · travado no teto' : ''}</div>
        </div>
        <div class="bloco">
          <div class="r">Teto da gratificação — ${brl(tetoDe(me))}</div>
          <div class="v" style="color:${me.atingPct >= 1 ? 'var(--ambar)' : 'var(--verde-esc)'}">${numBR(me.atingPct * 100, 1)}%</div>
          <div class="barra" style="height:10px;margin:4px 0 6px"><i class="${me.atingPct > 1 ? 'acima' : ''}" style="width:${Math.min(100, me.atingPct * 100)}%"></i></div>
          ${tetoParcial(me) ? `<div class="d">Teto prorata: ${me.diasPeriodo} de ${diasNoPeriodo(ctx.periodo.inicio, ctx.periodo.fim)} dias do período (admissão em ${brDate(me.admissao)}) · teto cheio ${brl(me.teto)}</div>` : ''}
          ${me.atingPct >= 1
            ? `<div class="d" style="color:var(--ambar);font-weight:600">Passou do teto em ${brl(me.gratif - tetoDe(me))}</div>`
            : `<div class="d">Faltam ${brl(faltaTeto)} para 100% do teto</div>`}
        </div>
        <div class="bloco total">
          <div class="r">Total a receber (estimado)</div>
          <div class="v">${brl(me.totalReceber)}</div>
          <div class="faixa-comp">
            <i style="width:${100 - pctGratifDoTotal}%;background:#7FB08F" title="Salário base"></i>
            <i style="width:${pctGratifDoTotal}%;background:#F5C56B" title="Gratificação"></i>
          </div>
          <div class="d">▮ Salário base ${brl(me.sal)} · ▮ Gratificação ${brl(me.gratif)}</div>
          <div class="d">Não inclui horas extras e DSR</div>
        </div>
      </div>

      <h2 style="margin-top:6px">Semana a semana</h2>
      <div class="dica">Quanto foi produzido e ganho em cada semana do período, com o acumulado — para acompanhar o ritmo até o fechamento.</div>
      <div class="colunas" style="height:100px;max-width:560px">
        ${semanasAcum.map(s => `
          <div class="col">
            <div class="v">${s.w ? numBR(s.w.valor, 0) : '—'}</div>
            <i style="height:${((s.w ? s.w.valor : 0) / maxSemValor * 100)}%;background:var(--ambar)"></i>
            <div class="lab">${s.rotulo}</div>
          </div>`).join('')}
      </div>
      <div class="scroll-x" style="margin-top:10px">
        <table>
          <thead><tr>
            <th>Semana</th><th>Período</th><th class="num">Viagens</th><th class="num">Toneladas</th><th class="num">Km méd.</th>
            <th class="num">Produção da semana (R$)</th><th class="num">Acumulado (R$)</th><th>% do teto acum.</th>
          </tr></thead>
          <tbody>
            ${semanasAcum.map(s => `
              <tr class="${s.w ? 'linha-clic' : ''}" ${s.w ? `title="Clique para ver o detalhe diário" data-semana-idx="${s.idx}"` : ''}>
                <td><b>${s.rotulo}</b></td>
                <td class="tag-sem">${s.faixa}</td>
                <td class="num">${s.w ? s.w.viagens : '—'}</td>
                <td class="num">${s.w ? numBR(s.w.ton, 1) : '—'}</td>
                <td class="num">${s.w && s.w.viagens && me.espec !== 'COLHEDORA' && me.espec !== 'TRANSBORDO' ? numBR(s.w.km / s.w.viagens, 0) : '—'}</td>
                <td class="num">${s.w ? numBR(s.w.valor) : '—'}</td>
                <td class="num" style="font-weight:600">${numBR(s.acum)}</td>
                <td><div style="display:flex;align-items:center;gap:6px">
                  <div class="barra" style="width:80px"><i class="${s.acum > tetoDe(me) ? 'acima' : ''}" style="width:${Math.min(100, (tetoDe(me) ? s.acum / tetoDe(me) : 0) * 100)}%"></i></div>
                  <span class="mono" style="font-size:11.5px">${numBR((tetoDe(me) ? s.acum / tetoDe(me) : 0) * 100, 1)}%</span>
                </div></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${me.ajustePct ? `
      <div class="ajuste-aplicado" style="margin-top:14px;padding:12px 14px;background:#EAF1FF;border:1px solid #B9D2F0;border-radius:6px">
        <div style="font-weight:700;font-size:13px;color:var(--azul);text-transform:uppercase;letter-spacing:.4px">Ajuste manual aplicado — +${numBR(me.ajustePct, 1)}%</div>
        <div style="margin-top:4px;font-size:13px">${esc(me.ajusteObs || '')}</div>
      </div>` : ''}
      <div class="tag-sem" style="margin-top:12px">Documento individual de conferência do colaborador · produção valorizada por pesagem conforme tabela vigente (R$/t × faixa de km) · gratificação proporcional aos dias trabalhados (base ${diasBase}) · valores não incluem horas extras e DSR · fechamento no dia 15.</div>
    </div>

    <div class="cartao cartao-relatorio">
      <h2>Dias sem expediente no período</h2>
      <div class="dica">Dias da escala (relatório de jornada) sem horário normal de turno — folgas (D.S.R., compensado), feriados, férias e atestados.${me.diasTrabalhadosReal != null ? ` Dias trabalhados: <b>${me.diasTrabalhadosReal}</b> de ${me.diasTrabalhados} esperados.` : ''}</div>
      ${(me.faltas || []).length ? `
      <div class="scroll-x" style="margin-top:6px">
        <table>
          <thead><tr><th>Dia</th><th>Motivo</th></tr></thead>
          <tbody>${me.faltas.map(fa => `<tr><td>${brDate(fa.data)}</td><td>${esc(fa.motivo)}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : '<div class="tag-sem">Nenhum dia sem expediente registrado nesse período (ou jornada não importada na aba Dados).</div>'}
    </div>
    ${modal}
    ${renderRelatorioSelecaoModal()}`;
}

function todosDiasColaborador(me) {
  const dias = {};
  Object.values(me.semanas || {}).forEach(sem => {
    Object.entries(sem.dias || {}).forEach(([iso, d]) => { dias[iso] = d; });
  });
  return dias;
}

function renderRelatorioSelecaoModal() {
  if (!state.extratoRelatorioModalAberto) return '';
  const { periodo } = contextoExtrato();
  const min = periodo.inicio, max = periodo.fim;
  return `
    <div class="modal-ov no-print" id="relatorioSelecaoOv">
      <div class="modal-box" id="relatorioSelecaoBox">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <h3>Relatório detalhado por período</h3>
          <button class="modal-fecha" id="relatorioSelecaoFechar">×</button>
        </div>
        <div class="dica">Escolha um único dia ou um intervalo (ex.: 4 ou 5 dias de uma semana específica) dentro do período de apuração (${brDate(min)} a ${brDate(max)}) para gerar um relatório detalhado pronto para impressão.</div>
        <div class="linha-form" style="margin-top:10px">
          <div class="campo"><label>De</label><input type="date" id="relatorioDataInicio" min="${min}" max="${max}" value="${min}"></div>
          <div class="campo"><label>Até</label><input type="date" id="relatorioDataFim" min="${min}" max="${max}" value="${max}"></div>
        </div>
        <div class="linha-form" style="margin-top:14px;justify-content:flex-end">
          <button class="btn sec" id="relatorioSelecaoCancelar">Cancelar</button>
          <button class="btn" id="relatorioSelecaoGerar">Gerar relatório</button>
        </div>
      </div>
    </div>`;
}

function renderRelatorioDetalhado(me, referenciaDia) {
  const { inicio, fim } = state.extratoRelatorioIntervalo;
  const especLabelFull = { CAMINHAO: 'Caminhão canavieiro', 'BATE-VOLTA': 'Caminhão bate e volta', COLHEDORA: 'Colhedora de cana', TRANSBORDO: 'Trator transbordo' }[me.espec] || me.espec;
  const diasFiltrados = Object.entries(todosDiasColaborador(me))
    .filter(([iso]) => iso >= inicio && iso <= fim)
    .sort((a, b) => a[0] < b[0] ? -1 : 1);

  const totais = diasFiltrados.reduce((acc, [, d]) => {
    acc.viagens += d.viagens; acc.ton += d.ton; acc.valor += d.valor; acc.km += d.km;
    return acc;
  }, { viagens: 0, ton: 0, valor: 0, km: 0 });

  const linhasDias = diasFiltrados.map(([iso, d]) => {
    const raioMed = d.viagens ? d.km / d.viagens : 0;
    return `
      <tr>
        <td>${dataCurta(new Date(iso + 'T00:00:00'))}</td>
        <td class="num">${d.viagens}</td>
        <td class="num">${d.viagens ? numBR(raioMed, 0) : '—'}</td>
        <td class="num">${numBR(d.ton, 1)}</td>
        <td class="num">${d.ton ? numBR(d.valor / d.ton, 4) : '—'}</td>
        <td class="num" style="font-weight:600">${numBR(d.valor)}</td>
        <td class="num tag-sem">${d.viagens ? numBR(referenciaDia(raioMed), 0) : '—'}</td>
      </tr>`;
  }).join('');
  const raioMedTotal = totais.viagens ? totais.km / totais.viagens : 0;
  const rotuloPeriodo = inicio === fim ? brDate(inicio) : `${brDate(inicio)} a ${brDate(fim)}`;

  return `
    <div class="linha-form no-print" style="justify-content:space-between">
      <button class="btn sec" id="btnVoltarExtrato">← Voltar ao extrato</button>
      <button class="btn" id="btnImprimirRelatorioDetalhado">Imprimir relatório</button>
    </div>
    <div class="cartao cartao-relatorio">
      <div class="recibo-topo">
        <div>
          <div class="idc">Matrícula ${esc(me.mat)}</div>
          ${state.exibirNomes ? `<div style="font-weight:600;margin-top:2px">${esc(me.nome)}</div>` : ''}
          <div class="tag-sem" style="margin-top:4px">${esc(especLabelFull)}${me.funcao ? ' · ' + esc(me.funcao) : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:'Barlow Condensed';font-weight:700;font-size:20px;color:var(--verde-esc);text-transform:uppercase;letter-spacing:.6px">Relatório detalhado</div>
          <div class="tag-sem">${rotuloPeriodo} · ${diasFiltrados.length} dia${diasFiltrados.length !== 1 ? 's' : ''} com produção</div>
        </div>
      </div>
      <div class="dica" style="margin-top:10px">Detalhe diário de viagens, raio médio e toneladas carregadas no período selecionado. Validação: R$/t unitário × toneladas = valor do dia. "Ton/dia padrão" é o valor esperado para o raio do dia, conforme a tabela de referência de precificação.</div>
      <div class="scroll-x" style="margin-top:10px">
        <table>
          <thead><tr><th>Dia</th><th class="num">Viagens</th><th class="num">Raio méd. (km)</th><th class="num">Toneladas</th><th class="num">R$/t unitário</th><th class="num">Valor (R$)</th><th class="num">Ton/dia padrão</th></tr></thead>
          <tbody>
            ${linhasDias || '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted)">Sem viagens registradas nesse período.</td></tr>'}
            ${diasFiltrados.length ? `
            <tr style="font-weight:600;border-top:2px solid var(--verde)">
              <td>Total</td>
              <td class="num">${totais.viagens}</td>
              <td class="num">${totais.viagens ? numBR(raioMedTotal, 0) : '—'}</td>
              <td class="num">${numBR(totais.ton, 1)}</td>
              <td class="num">${totais.ton ? numBR(totais.valor / totais.ton, 4) : '—'}</td>
              <td class="num">${numBR(totais.valor)}</td>
              <td class="num tag-sem">${totais.viagens ? numBR(referenciaDia(raioMedTotal), 0) : '—'}</td>
            </tr>` : ''}
          </tbody>
        </table>
      </div>
      <div class="tag-sem" style="margin-top:12px">Relatório gerado a partir do extrato do colaborador · matrícula ${esc(me.mat)} · período de apuração completo ${brDate(contextoExtrato().periodo.inicio)} a ${brDate(contextoExtrato().periodo.fim)}.</div>
    </div>`;
}

function wireExtrato() {
  if (state.extratoRelatorioIntervalo) {
    const btnVoltar = $('#btnVoltarExtrato');
    if (btnVoltar) btnVoltar.onclick = () => { state.extratoRelatorioIntervalo = null; render(); };
    const btnImprimirRel = $('#btnImprimirRelatorioDetalhado');
    if (btnImprimirRel) btnImprimirRel.onclick = () => window.print();
    return;
  }
  const selPeriodo = $('#extratoPeriodo');
  if (selPeriodo) selPeriodo.onchange = async e => {
    state.extratoFechamento = e.target.value || null;
    state.extratoMat = null;
    state.extratoSemanaAberta = null;
    state.extratoRelatorioIntervalo = null;
    if (state.extratoFechamento) {
      $('#main').innerHTML = '<div class="cartao"><div class="dica">Carregando período fechado…</div></div>';
      try { await carregarFechamentoDetalhe(state.extratoFechamento); } catch (err) { showToast('erro', err.message); }
    }
    render();
  };
  const btnVoltarHist = $('#btnVoltarHistorico');
  if (btnVoltarHist) btnVoltarHist.onclick = () => {
    state.filtroHistorico.chave = state.extratoFechamento;
    setView('historico');
  };
  const select = $('#extratoSelect');
  if (select) select.onchange = e => { state.extratoMat = e.target.value; state.extratoSemanaAberta = null; render(); };
  const btnImprimir = $('#btnImprimirExtrato');
  if (btnImprimir) btnImprimir.onclick = () => window.print();
  const btnRelatorio = $('#btnRelatorioDetalhado');
  if (btnRelatorio) btnRelatorio.onclick = () => { state.extratoRelatorioModalAberto = true; render(); };
  $('#main').querySelectorAll('[data-semana-idx]').forEach(tr => {
    tr.onclick = () => { state.extratoSemanaAberta = +tr.dataset.semanaIdx; render(); };
  });
  const ov = $('#extratoModalOv');
  if (ov) {
    ov.onclick = () => { state.extratoSemanaAberta = null; render(); };
    $('#extratoModalBox').onclick = e => e.stopPropagation();
    $('#extratoModalFechar').onclick = () => { state.extratoSemanaAberta = null; render(); };
  }
  const ovSel = $('#relatorioSelecaoOv');
  if (ovSel) {
    const fecharSel = () => { state.extratoRelatorioModalAberto = false; render(); };
    ovSel.onclick = fecharSel;
    $('#relatorioSelecaoBox').onclick = e => e.stopPropagation();
    $('#relatorioSelecaoFechar').onclick = fecharSel;
    $('#relatorioSelecaoCancelar').onclick = fecharSel;
    $('#relatorioSelecaoGerar').onclick = () => {
      const inicio = $('#relatorioDataInicio').value;
      const fim = $('#relatorioDataFim').value;
      if (!inicio || !fim) { showToast('erro', 'Escolha as duas datas.'); return; }
      if (inicio > fim) { showToast('erro', 'A data inicial não pode ser depois da final.'); return; }
      state.extratoRelatorioModalAberto = false;
      state.extratoRelatorioIntervalo = { inicio, fim };
      render();
    };
  }
}

/* =============== aba: parametros =============== */
function renderParametros() {
  const p = PARAMS;
  const diasBase = DADOS.diasBase;
  const linhaFaixa = (tabela, chaveTab, rotulo) => `
    <tr><td><b>${rotulo}</b> R$/t</td>${tabela.map((f, i) => `
      <td class="num"><input type="number" step="0.0001" style="width:60px;font-size:12px" data-tab="${chaveTab}" data-idx="${i}" value="${f.rate}"></td>`).join('')}
    </tr>`;
  const especCaminhoes = p.especialidades.filter(e => e.chave === 'CAMINHAO' || e.chave === 'BATE-VOLTA');
  const metaColhedPeriodo = p.tetoColhedora.metaDia * diasBase;
  const rtColhed = p.tetoColhedora.metaDia > 0 && diasBase > 0 ? p.tetoColhedora.valor / metaColhedPeriodo : 0;
  const metaTransbPeriodo = p.tetoTransbordo.metaDia * diasBase;
  const rtTransb = p.tetoTransbordo.metaDia > 0 && diasBase > 0 ? p.tetoTransbordo.valor / metaTransbPeriodo : 0;

  return `
    <div class="cartao">
      <h2>Régua de faixas — R$ por tonelada × distância da viagem</h2>
      <div class="dica">Quanto maior o raio médio, menos viagens o caminhão consegue fazer no dia — por isso o R$/t cresce com a distância, mantendo o potencial de gratificação equivalente entre frentes perto e longe. Mesma tabela para canavieiro, prancha e bombeiro; a de bate e volta inicia igual e pode ser ajustada.</div>
      <div style="display:flex;gap:8px;margin:10px 0;flex-wrap:wrap">
        <button class="btn sec" id="btnAddFaixa">+ Adicionar faixa</button>
        <button class="btn sec" id="btnDelFaixa">− Remover última faixa</button>
        <button class="btn sec" id="btnResetFaixas">Restaurar padrão</button>
      </div>
      <div class="scroll-x">
        <table>
          <thead><tr><th>Faixa (km)</th>${p.tabelaCanavieiro.map(f => `<th class="num">${f.ini}–${f.fim}</th>`).join('')}</tr></thead>
          <tbody>
            ${linhaFaixa(p.tabelaCanavieiro, 'tabelaCanavieiro', 'Canavieiro')}
            ${linhaFaixa(p.tabelaBateVolta, 'tabelaBateVolta', 'Bate e volta')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="grade2">
      <div class="cartao">
        <h2>Especialidades e valores 100%</h2>
        <div class="dica">Colhedora e transbordo pagam R$/t fixo (independe de km). Teto = gratificação 100% do nível (só produção). Salário base padrão é usado quando não vier na importação.</div>
        <table>
          <thead><tr><th>Especialidade</th><th>Cálculo</th><th class="num">R$/t</th><th class="num">Valor produção (R$)</th><th class="num">Salário base (R$)</th></tr></thead>
          <tbody>
            ${especCaminhoes.map(e => `
              <tr data-chave="${e.chave}">
                <td>${esc(e.rotulo)}</td>
                <td class="tag-sem">${e.modo === 'faixa' ? 'por faixa de km' : 'R$/t fixo'}</td>
                <td class="num">${e.modo === 'fixo' ? `<input type="number" step="0.001" class="in-espec" data-campo="rate" value="${e.rate}">` : '—'}</td>
                <td class="num"><input type="number" class="in-espec" data-campo="valorProd" value="${e.valorProd}"></td>
                <td class="num"><input type="number" step="0.01" class="in-espec" data-campo="salBase" value="${e.salBase}"></td>
              </tr>`).join('')}
          </tbody>
        </table>

        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--linha)">
          <div style="font-weight:700;font-size:13px;margin-bottom:6px">Método de cálculo da produção</div>
          <label style="font-size:13px;display:flex;gap:8px;align-items:flex-start;margin-bottom:6px">
            <input type="radio" name="metodo" id="metPesagem" ${p.modoCalculo === 'pesagem' ? 'checked' : ''}>
            <span><b>Por pesagem individual</b> — soma dos valores das pesagens do colaborador (R$/t × faixa). Ideal para o acompanhamento semanal.</span>
          </label>
          <label style="font-size:13px;display:flex;gap:8px;align-items:flex-start">
            <input type="radio" name="metodo" id="metFrota" ${p.modoCalculo === 'frota' ? 'checked' : ''}>
            <span><b>Por frota (rateio da equipe)</b> — % da frota como no fechamento oficial (colhedora: t ÷ ${numBR(p.frotaConfig.metaDiaColhed, 0)} t/dia-efetivo × R$ ${numBR(p.frotaConfig.valorColhed, 0)} · transbordo: t ÷ ${numBR(p.frotaConfig.metaDiaTransb, 1)} t/dia × R$ ${numBR(p.frotaConfig.valorTransb, 0)} · caminhão: Σ peso × taxa-base ajustado por dias). O colaborador recebe o valor da frota em que mais produziu. Requer a coluna Cód-Frota na importação.</span>
          </label>
        </div>
        <div style="margin-top:12px">
          <label style="font-size:13px;display:flex;gap:8px;align-items:center">
            <input type="checkbox" id="chkAplicarTeto" ${p.aplicarTeto ? 'checked' : ''}>
            Travar gratificação no teto de 100% (o fechamento atual paga acima do teto)
          </label>
        </div>
      </div>

      <div class="cartao">
        <h2>Rateio por frota</h2>
        <div class="dica">Usado somente no método "por frota". Definido junto com o fechamento oficial — não editável por aqui por enquanto.</div>
        <table>
          <tbody>
            <tr><td>Colhedora — meta (t/dia-efetivo)</td><td class="num mono">${numBR(p.frotaConfig.metaDiaColhed, 0)}</td></tr>
            <tr><td>Colhedora — R$ 100%</td><td class="num mono">${brl(p.frotaConfig.valorColhed)}</td></tr>
            <tr><td>Transbordo — meta (t/dia)</td><td class="num mono">${numBR(p.frotaConfig.metaDiaTransb, 1)}</td></tr>
            <tr><td>Transbordo — R$ 100%</td><td class="num mono">${brl(p.frotaConfig.valorTransb)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="grade2">
      <div class="cartao">
        <h2>Operador de colhedora</h2>
        <div class="dica">Módulo próprio, separado do caminhão: meta de <b>${numBR(p.tetoColhedora.metaDia, 0)} t/dia por colaborador</b> × ${diasBase} dias-base = meta do período de <b>${numBR(metaColhedPeriodo, 0)} t</b>. Atingimento = toneladas colhidas ÷ meta; gratificação = % × R$ ${numBR(p.tetoColhedora.valor, 0)} (equivale a ${numBR(rtColhed, 5)} R$/t). A proporcionalidade dos dias já está embutida na meta diária.</div>
        <div class="linha-form">
          <div class="campo"><label>Meta (t/dia por colaborador)</label><input type="number" step="1" id="colMetaDia" value="${p.tetoColhedora.metaDia}"></div>
          <div class="campo"><label>Gratificação 100% (R$)</label><input type="number" step="1" id="colValor" value="${p.tetoColhedora.valor}"></div>
          <div class="campo"><label>Meta do período (t)</label><div class="mono" style="padding:8px 0;font-weight:600">${numBR(metaColhedPeriodo, 0)} t</div></div>
          <div class="campo"><label>R$/t equivalente</label><div class="mono" style="padding:8px 0;font-weight:600">${numBR(rtColhed, 5)}</div></div>
        </div>
      </div>
      <div class="cartao">
        <h2>Operador de transbordo</h2>
        <div class="dica">Módulo próprio, separado do caminhão: meta de <b>${numBR(p.tetoTransbordo.metaDia, 0)} t/dia por colaborador</b> × ${diasBase} dias-base = meta do período de <b>${numBR(metaTransbPeriodo, 0)} t</b>. Atingimento = toneladas transbordadas ÷ meta; gratificação = % × R$ ${numBR(p.tetoTransbordo.valor, 0)} (equivale a ${numBR(rtTransb, 5)} R$/t). A proporcionalidade dos dias já está embutida na meta diária.</div>
        <div class="linha-form">
          <div class="campo"><label>Meta (t/dia por colaborador)</label><input type="number" step="1" id="transMetaDia" value="${p.tetoTransbordo.metaDia}"></div>
          <div class="campo"><label>Gratificação 100% (R$)</label><input type="number" step="1" id="transValor" value="${p.tetoTransbordo.valor}"></div>
          <div class="campo"><label>Meta do período (t)</label><div class="mono" style="padding:8px 0;font-weight:600">${numBR(metaTransbPeriodo, 0)} t</div></div>
          <div class="campo"><label>R$/t equivalente</label><div class="mono" style="padding:8px 0;font-weight:600">${numBR(rtTransb, 5)}</div></div>
        </div>
      </div>
    </div>

    <div class="linha-form" style="margin-top:4px">
      <button class="btn" id="btnSalvarParametros">Salvar parâmetros</button>
    </div>`;
}
function wireParametros() {
  const p = PARAMS;

  $('#main').querySelectorAll('input[data-tab]').forEach(inp => {
    inp.onchange = () => {
      const tab = inp.dataset.tab, idx = +inp.dataset.idx;
      p[tab][idx].rate = parseFloat(inp.value) || 0;
    };
  });

  $('#btnAddFaixa').onclick = () => {
    for (const tab of ['tabelaCanavieiro', 'tabelaBateVolta']) {
      const ultima = p[tab][p[tab].length - 1] || { fim: 0, rate: 0 };
      p[tab] = [...p[tab], { ini: ultima.fim + 1, fim: ultima.fim + 5, rate: ultima.rate }];
    }
    render();
  };
  $('#btnDelFaixa').onclick = () => {
    if (p.tabelaCanavieiro.length <= 1) return;
    p.tabelaCanavieiro = p.tabelaCanavieiro.slice(0, -1);
    p.tabelaBateVolta = p.tabelaBateVolta.slice(0, -1);
    render();
  };
  $('#btnResetFaixas').onclick = async () => {
    const btn = $('#btnResetFaixas');
    setBtnLoading(btn, true);
    try {
      const r = await api('/parametros/restaurar-faixas', { method: 'POST' });
      Object.assign(PARAMS, r);
      render();
      showToast('ok', 'Réguas de faixa restauradas ao padrão.');
    } catch (e) { showToast('erro', e.message); }
    finally { setBtnLoading(btn, false); }
  };

  $('#main').querySelectorAll('.in-espec').forEach(inp => {
    inp.onchange = () => {
      const chave = inp.closest('tr').dataset.chave, campo = inp.dataset.campo;
      const e = p.especialidades.find(x => x.chave === chave);
      if (e) e[campo] = parseFloat(inp.value) || 0;
    };
  });

  $('#metPesagem').onchange = () => { p.modoCalculo = 'pesagem'; };
  $('#metFrota').onchange = () => { p.modoCalculo = 'frota'; };
  $('#chkAplicarTeto').onchange = e => { p.aplicarTeto = e.target.checked; };

  $('#colMetaDia').onchange = e => { p.tetoColhedora.metaDia = parseFloat(e.target.value) || 0; render(); };
  $('#colValor').onchange = e => { p.tetoColhedora.valor = parseFloat(e.target.value) || 0; render(); };
  $('#transMetaDia').onchange = e => { p.tetoTransbordo.metaDia = parseFloat(e.target.value) || 0; render(); };
  $('#transValor').onchange = e => { p.tetoTransbordo.valor = parseFloat(e.target.value) || 0; render(); };

  $('#btnSalvarParametros').onclick = async () => {
    const btn = $('#btnSalvarParametros');
    setBtnLoading(btn, true);
    try {
      PARAMS = await api('/parametros', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(PARAMS) });
      showToast('ok', 'Parâmetros salvos.');
    } catch (e) { showToast('erro', e.message); }
    finally { setBtnLoading(btn, false); }
  };
}

/* =============== aba: calculo =============== */
const ESPEC_LABEL = { CAMINHAO: 'Caminhão', 'BATE-VOLTA': 'Bate-volta', COLHEDORA: 'Colhedora', TRANSBORDO: 'Transbordo' };
const ESPEC_BADGE = { CAMINHAO: 'b-cam', 'BATE-VOLTA': 'b-bv', COLHEDORA: 'b-col', TRANSBORDO: 'b-tra' };
function badgeEspec(espec) {
  return `<span class="badge ${ESPEC_BADGE[espec] || 'b-cam'}">${ESPEC_LABEL[espec] || esc(espec)}</span>`;
}

/* termos ativos da busca: os fixados + o que esta sendo digitado agora */
function termosBuscaCalculo() {
  const f = state.filtroCalculo;
  return [...(f.buscasFixadas || []), f.busca].map(t => String(t || '').trim()).filter(Boolean);
}
const casaComTermo = (k, t) => norm(k.nome).includes(norm(t)) || String(k.mat).includes(t);

function calculoFiltrado() {
  const f = state.filtroCalculo;
  const lista = CALC ? CALC.lista : [];
  const termos = termosBuscaCalculo();
  return lista.filter(k =>
    (!f.apenasComProducao || k.viagens > 0) &&
    (f.especialidade === 'TODOS' || k.espec === f.especialidade) &&
    (f.departamento === 'TODOS' || (k.departamento || 'Não informado') === f.departamento) &&
    (!termos.length || termos.some(t => casaComTermo(k, t)))
  );
}

function linhaCalculo(k) {
  const f = state.filtroCalculo;
  const frotasEntries = Object.entries(k.frotas || {}).sort((a, b) => b[1].ton - a[1].ton);
  const aberto = f.detalheAberto === k.mat;
  const admissao = k.admissao ? brDate(k.admissao) : '—';
  const linhaPrincipal = `
    <tr class="linha-calc" data-mat="${esc(k.mat)}">
      <td class="mono">${esc(k.mat)}</td>
      <td>${state.exibirNomes ? esc(k.nome) : `Colaborador ${esc(k.mat)}`}<div class="tag-sem">${esc(k.funcao || '')}</div></td>
      <td class="tag-sem">${esc(k.departamento || 'Não informado')}</td>
      <td class="num tag-sem" style="white-space:nowrap">${admissao}</td>
      <td>${badgeEspec(k.espec)}</td>
      <td class="num">${k.diasTrabalhados}</td>
      <td class="num">${k.diasTrabalhadosReal}${(k.faltas && k.faltas.length)
        ? ` <button type="button" class="btn peq sec" data-faltas="${esc(k.mat)}" title="Ver dias sem expediente (folgas, atestados, feriados...)">🗓️ ${k.faltas.length}</button>`
        : ''}</td>
      <td class="num">${k.viagens}</td>
      <td class="num">${numBR(k.ton, 1)}</td>
      <td class="num">${k.kmMed ? numBR(k.kmMed, 0) : '—'}</td>
      <td style="white-space:nowrap">${frotasEntries.length
        ? `<button type="button" class="btn peq sec" data-detalhe="${esc(k.mat)}">🔍 ${frotasEntries.length} frota${frotasEntries.length > 1 ? 's' : ''} ${aberto ? '▴' : '▾'}</button>`
        : '—'}</td>
      <td class="num">${numBR(k.sal)}</td>
      <td class="num" style="font-weight:600;color:var(--verde-esc)">${numBR(k.gratif)}</td>
      <td class="num"${tetoParcial(k) ? ` title="Teto prorata: ${k.diasPeriodo} de ${diasNoPeriodo(DADOS.periodo.inicio, DADOS.periodo.fim)} dias do período (teto cheio R$ ${numBR(k.teto, 0)})"` : ''}>${numBR(tetoDe(k), 0)}${tetoParcial(k) ? '<span class="tag-sem" style="margin-left:3px">pr</span>' : ''}</td>
      <td><div style="display:flex;align-items:center;gap:6px">
        <div class="barra" style="width:80px"><i class="${k.atingPct > 1 ? 'acima' : ''}" style="width:${Math.min(100, k.atingPct * 100)}%"></i></div>
        <span class="mono" style="font-size:11.5px;font-weight:${k.atingPct > 1 ? 700 : 400}${k.atingPct > 1 ? ';color:var(--ambar)' : ''}">${numBR(k.atingPct * 100, 1)}%</span>
        ${k.ajustePct ? `<span class="tag-sem" style="color:var(--azul)" title="Ajuste manual: +${numBR(k.ajustePct, 1)}% — ${esc(k.ajusteObs || '')}">+${numBR(k.ajustePct, 1)}% ajuste</span>` : ''}
      </div></td>
      <td class="num" style="font-weight:600">${numBR(k.totalReceber)}</td>
      <td class="col-acoes" style="white-space:nowrap">
        <button type="button" class="btn peq sec" data-extrato="${esc(k.mat)}" title="Abrir extrato do colaborador">📄 Extrato</button>
        ${podeAdministrar() ? `<button type="button" class="btn peq sec" data-ajuste="${esc(k.mat)}" title="Ajustar percentual manualmente">⚙️ Ajuste</button>` : ''}
        ${podeSugerirAjuste() ? `<button type="button" class="btn peq sec" data-ajuste="${esc(k.mat)}" title="Sugerir ajuste (precisa de aprovação)">📝 Sugerir ajuste</button>` : ''}
      </td>
    </tr>`;
  if (!aberto) return linhaPrincipal;
  const mapaFrotas = new Map((DADOS.frotas || []).map(fr => [String(fr.frota), fr]));
  const corpoDetalhe = frotasEntries.length
    ? frotasEntries.map(([cod, dv]) => {
        const disp = mapaFrotas.get(String(cod));
        const pctTon = k.ton ? numBR(100 * dv.ton / k.ton, 0) : '0';
        return `
          <div class="frota-item">
            <div class="fi-cod mono">${esc(cod)}</div>
            <div class="fi-desc">${disp && disp.desc ? esc(disp.desc) : '—'}</div>
            <div class="fi-ton mono">${numBR(dv.ton, 0)} t · ${dv.vg} vg · ${pctTon}% da produção</div>
            <div class="fi-disp">${disp
              ? `<div class="barra" style="width:90px"><i style="width:${Math.min(100, disp.pct)}%;background:${disp.pct >= 85 ? 'var(--verde)' : disp.pct >= 70 ? 'var(--ambar)' : 'var(--vermelho)'}"></i></div><span class="mono" style="font-size:11.5px">${numBR(disp.pct, 1)}% disponibilidade</span>`
              : `<span class="tag-sem">${(DADOS.frotas || []).length ? 'frota sem registro de disponibilidade' : 'importe a disponibilidade na aba Dados'}</span>`}</div>
          </div>`;
      }).join('')
    : '<span class="tag-sem">Sem frota registrada nas pesagens.</span>';
  return linhaPrincipal + `
    <tr class="linha-frotas"><td colspan="17"><div class="frotas-box">${corpoDetalhe}</div></td></tr>`;
}

function tabelaCalculo(lista) {
  if (!lista.length) {
    return `<div class="scroll-x"><table><tbody><tr><td style="text-align:center;padding:24px;color:var(--muted)">Sem dados — importe as bases ou carregue a demonstração na aba Dados.</td></tr></tbody></table></div>`;
  }
  return `
    <div class="scroll-x tabela-calc">
      <table>
        <thead><tr>
          <th style="width:65px">Mat.</th><th style="width:160px">Colaborador</th><th style="width:150px">Departamento</th><th style="width:88px">Admissão</th><th style="width:90px">Espec.</th>
          <th class="num" style="width:45px">Dias</th><th class="num" style="width:95px">Dias trabalhados</th><th class="num" style="width:60px">Viagens</th><th class="num" style="width:70px">Ton</th><th class="num" style="width:65px">Km méd.</th>
          <th style="width:150px">Frotas / disponib.</th><th class="num" style="width:85px">Salário base</th><th class="num" style="width:95px">Gratificação (R$)</th>
          <th class="num" style="width:75px">Teto (R$)</th><th style="width:120px">% Atingido</th><th class="num" style="width:90px">Total (R$)</th><th class="col-acoes" style="width:195px">Ações</th>
        </tr></thead>
        <tbody>${lista.map(linhaCalculo).join('')}</tbody>
      </table>
    </div>`;
}

function renderAjusteModal() {
  const mat = state.ajusteModalMat;
  if (!mat) return '';
  const k = (CALC.lista || []).find(x => x.mat === mat);
  if (!k) return '';
  const sugerir = podeSugerirAjuste();
  return `
    <div class="modal-ov no-print" id="ajusteModalOv">
      <div class="modal-box" id="ajusteModalBox">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <h3>${sugerir ? 'Sugerir ajuste' : 'Ajuste manual'} — ${esc(k.mat)}</h3>
          <button class="modal-fecha" id="ajusteModalFechar">×</button>
        </div>
        <div class="dica">Soma valor à gratificação deste colaborador, na proporção do teto nominal do nível — R$ ${numBR(k.teto, 0)} (ex.: produção real não capturada pelo sistema, como viagens particulares). O total nunca ultrapassa o teto nominal por conta deste ajuste. É obrigatório justificar — fica registrado para auditoria e aparece no extrato do colaborador.${tetoParcial(k) ? ` <b>Atenção:</b> este colaborador pegou só ${k.diasPeriodo} de ${diasNoPeriodo(DADOS.periodo.inicio, DADOS.periodo.fim)} dias do período, então o teto cobrado dele é R$ ${numBR(tetoDe(k), 0)} — cada 1% aqui pesa mais no % atingido dele.` : ''}${sugerir ? ' Sua sugestão precisa ser aprovada por Gerente e Diretoria antes de valer.' : ''}</div>
        <div class="campo" style="margin-top:10px;max-width:160px">
          <label>Percentual a somar (%)</label>
          <input type="number" step="0.1" id="ajustePctInput" value="${sugerir ? '' : esc(k.ajustePct ?? '')}" placeholder="ex: 15">
        </div>
        <div class="campo" style="margin-top:10px">
          <label>Observação (obrigatória)</label>
          <textarea id="ajusteObsInput" rows="3" style="width:100%;font-family:'Inter';font-size:13px;padding:8px;border:1px solid var(--linha);border-radius:5px;box-sizing:border-box" placeholder="Explique o motivo do ajuste…">${sugerir ? '' : esc(k.ajusteObs || '')}</textarea>
        </div>
        <div class="linha-form" style="margin-top:14px;justify-content:space-between">
          ${sugerir ? '<span></span>' : `<button class="btn sec" id="ajusteRemover" style="color:var(--vermelho);border-color:var(--vermelho)" ${k.ajustePct ? '' : 'disabled'}>Remover ajuste</button>`}
          <div style="display:flex;gap:8px">
            <button class="btn sec" id="ajusteCancelar">Cancelar</button>
            <button class="btn" id="ajusteSalvar">${sugerir ? 'Enviar para aprovação' : 'Salvar ajuste'}</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderFaltasModal() {
  const mat = state.faltasModalMat;
  if (!mat) return '';
  const k = (CALC.lista || []).find(x => x.mat === mat);
  if (!k) return '';
  const faltas = k.faltas || [];
  return `
    <div class="modal-ov no-print" id="faltasModalOv">
      <div class="modal-box" id="faltasModalBox">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <h3>Dias sem expediente — ${esc(k.mat)}${state.exibirNomes ? ' · ' + esc(k.nome) : ''}</h3>
          <button class="modal-fecha" id="faltasModalFechar">×</button>
        </div>
        <div class="dica">Dias do período em que a escala (relatório de jornada importado) não teve horário normal de turno — inclui folgas (D.S.R., feriado, férias, compensado) e afastamentos (atestado). É a escala planejada pelo RH, não o ponto batido — não indica falta não programada.</div>
        <div class="scroll-x" style="margin-top:10px">
          <table>
            <thead><tr><th>Dia</th><th>Motivo</th></tr></thead>
            <tbody>
              ${faltas.length
                ? faltas.map(fa => `<tr><td>${brDate(fa.data)}</td><td>${esc(fa.motivo)}</td></tr>`).join('')
                : '<tr><td colspan="2" style="text-align:center;padding:20px;color:var(--muted)">Sem dias registrados nesse período.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderCalculo() {
  if (!CALC) return placeholder('Cálculo');
  const f = state.filtroCalculo;
  const filtrado = calculoFiltrado();
  const departamentos = [...new Set(CALC.lista.map(k => k.departamento || 'Não informado'))].sort();
  const resumo = filtrado.reduce((acc, k) => {
    acc.n++; acc.ton += k.ton; acc.viagens += k.viagens; acc.gratif += k.gratif; acc.sal += k.sal; acc.totalReceber += k.totalReceber; acc.teto += tetoDe(k); acc.ajusteValor += k.ajusteValor || 0;
    return acc;
  }, { n: 0, ton: 0, viagens: 0, gratif: 0, sal: 0, totalReceber: 0, teto: 0, ajusteValor: 0 });
  const atingMedioPct = resumo.teto > 0 ? 100 * resumo.gratif / resumo.teto : 0;
  const gratifSemAjuste = resumo.gratif - resumo.ajusteValor;
  const ajustePctSobreTotal = gratifSemAjuste > 0 ? 100 * resumo.ajusteValor / gratifSemAjuste : 0;
  const diasBase = DADOS.diasBase;
  const especCaminhao = (PARAMS.especialidades || []).find(e => e.chave === 'CAMINHAO') || {};
  const criterio = `Caminhão/Bate-volta: peso (t) × R$/t da faixa de km da viagem · teto R$ ${numBR(especCaminhao.valorProd || 0, 0)} · prorata ${diasBase} dias-base. `
    + `Colhedora: meta ${numBR(PARAMS.tetoColhedora.metaDia, 0)} t/dia × ${diasBase} dias-base = ${numBR(PARAMS.tetoColhedora.metaDia * diasBase, 0)} t · gratificação = % da meta × R$ ${numBR(PARAMS.tetoColhedora.valor, 0)}. `
    + `Transbordo: meta ${numBR(PARAMS.tetoTransbordo.metaDia, 0)} t/dia × ${diasBase} dias-base = ${numBR(PARAMS.tetoTransbordo.metaDia * diasBase, 0)} t · gratificação = % da meta × R$ ${numBR(PARAMS.tetoTransbordo.valor, 0)}. `
    + `Quem foi admitido durante o período tem o teto prorata aos dias corridos que pegou — teto do nível ÷ ${diasNoPeriodo(DADOS.periodo.inicio, DADOS.periodo.fim)} dias do período × dias do colaborador (marcado com "pr" na coluna Teto) — e o % atingido é medido contra esse teto.`;

  return `
    <div class="kpis">
      <div class="kpi"><div class="rot">Colaboradores</div><div class="val">${resumo.n}</div><div class="det">${f.especialidade === 'TODOS' ? 'todas as especialidades' : ESPEC_LABEL[f.especialidade] || f.especialidade}</div></div>
      <div class="kpi"><div class="rot">Toneladas no período</div><div class="val">${numBR(resumo.ton, 0)}</div><div class="det">${resumo.viagens.toLocaleString('pt-BR')} viagens</div></div>
      <div class="kpi"><div class="rot">Gratificação (R$)</div><div class="val">${numBR(resumo.gratif, 0)}</div><div class="det">prorata base ${diasBase} dias</div></div>
      <div class="kpi"><div class="rot">Meta gratificação (R$)</div><div class="val">${numBR(resumo.teto, 0)}</div><div class="det">tetos prorata por admissão · ${resumo.n} colaboradores</div></div>
      <div class="kpi"><div class="rot">Atingimento médio</div><div class="val">${numBR(atingMedioPct, 1)}%</div><div class="det">R$ ${numBR(resumo.gratif, 0)} de R$ ${numBR(resumo.teto, 0)} da meta</div></div>
      <div class="kpi"><div class="rot">Média por colaborador (R$)</div><div class="val">${numBR(resumo.n ? resumo.gratif / resumo.n : 0, 0)}</div><div class="det">meta média R$ ${numBR(resumo.n ? resumo.teto / resumo.n : 0, 0)} por colaborador</div></div>
      ${resumo.ajusteValor ? `<div class="kpi" style="border-top-color:var(--azul)"><div class="rot">Ajustes manuais (R$)</div><div class="val" style="color:var(--azul)">+${numBR(resumo.ajusteValor, 0)}</div><div class="det">+${numBR(ajustePctSobreTotal, 1)}% sobre a gratificação sem ajustes</div></div>` : ''}
      <div class="kpi"><div class="rot">Folha salário base (R$)</div><div class="val">${numBR(resumo.sal, 0)}</div><div class="det">soma dos ${resumo.n} colaboradores</div></div>
      <div class="kpi"><div class="rot">Salário + gratificação</div><div class="val">${numBR(resumo.totalReceber, 0)}</div><div class="det">sem HE e DSR</div></div>
    </div>
    <div class="cartao">
      <div class="linha-form" style="justify-content:space-between">
        <h2 style="margin:0">Cálculo por colaborador</h2>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <input id="calcBusca" placeholder="Buscar nome ou matrícula…" title="Digite e tecle Enter para fixar o colaborador no filtro e continuar buscando outros" value="${esc(f.busca)}" style="width:220px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;white-space:nowrap">
            <input type="checkbox" id="calcSoProducao" ${f.apenasComProducao ? 'checked' : ''}> Só com produção
          </label>
          <select id="calcEspec">
            <option value="TODOS" ${f.especialidade === 'TODOS' ? 'selected' : ''}>Todas especialidades</option>
            <option value="CAMINHAO" ${f.especialidade === 'CAMINHAO' ? 'selected' : ''}>Caminhão canavieiro</option>
            <option value="BATE-VOLTA" ${f.especialidade === 'BATE-VOLTA' ? 'selected' : ''}>Bate e volta</option>
            <option value="COLHEDORA" ${f.especialidade === 'COLHEDORA' ? 'selected' : ''}>Operador colhedora</option>
            <option value="TRANSBORDO" ${f.especialidade === 'TRANSBORDO' ? 'selected' : ''}>Operador transbordo</option>
          </select>
          <select id="calcDepto">
            <option value="TODOS" ${f.departamento === 'TODOS' ? 'selected' : ''}>Todos os departamentos</option>
            ${departamentos.map(d => `<option value="${esc(d)}" ${f.departamento === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
          </select>
          <button class="btn sec no-print" id="btnExportarCalculoXlsx">Exportar Excel</button>
          <button class="btn no-print" id="btnExportarCalculoPdf">Exportar PDF</button>
        </div>
      </div>
      ${(f.buscasFixadas || []).length ? `
        <div class="busca-fixos">
          <span class="tag-sem">Colaboradores no filtro:</span>
          ${f.buscasFixadas.map((t, i) => `<span class="chip-busca">${esc(t)}<button type="button" data-tirarbusca="${i}" title="Tirar do filtro">×</button></span>`).join('')}
          <button type="button" class="btn peq sec" id="limparBuscas">Limpar seleção</button>
        </div>` : `<div class="dica" style="margin-top:6px">Dica: tecle <b>Enter</b> na busca para fixar um colaborador e ir somando outros ao filtro.</div>`}
      <div class="dica" style="margin-top:6px">${esc(criterio)}</div>
      ${filtrado.length ? tabelaCalculo(filtrado) : '<div style="text-align:center;padding:24px;color:var(--muted)">Nenhum colaborador encontrado com esses filtros.</div>'}
    </div>
    ${renderAjusteModal()}
    ${renderFaltasModal()}`;
}
function wireCalculo() {
  const f = state.filtroCalculo;
  $('#calcBusca').oninput = e => { f.busca = e.target.value; renderPreservandoFoco(); };
  $('#calcBusca').onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const termo = (f.busca || '').trim();
    if (!termo) return;
    f.buscasFixadas = f.buscasFixadas || [];
    if (!f.buscasFixadas.some(t => norm(t) === norm(termo))) f.buscasFixadas.push(termo);
    f.busca = '';
    renderPreservandoFoco();
  };
  $('#main').querySelectorAll('[data-tirarbusca]').forEach(btn => {
    btn.onclick = () => { f.buscasFixadas.splice(+btn.dataset.tirarbusca, 1); render(); };
  });
  const btnLimparBuscas = $('#limparBuscas');
  if (btnLimparBuscas) btnLimparBuscas.onclick = () => { f.buscasFixadas = []; f.busca = ''; render(); };
  $('#calcSoProducao').onchange = e => { f.apenasComProducao = e.target.checked; render(); };
  $('#calcEspec').onchange = e => { f.especialidade = e.target.value; render(); };
  $('#calcDepto').onchange = e => { f.departamento = e.target.value; render(); };
  $('#main').querySelectorAll('[data-detalhe]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const mat = btn.dataset.detalhe;
      f.detalheAberto = f.detalheAberto === mat ? null : mat;
      renderMantendoLinha(mat);
    };
  });
  $('#main').querySelectorAll('[data-extrato]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      state.extratoMat = btn.dataset.extrato;
      setView('extrato');
    };
  });
  $('#main').querySelectorAll('[data-ajuste]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      state.ajusteModalMat = btn.dataset.ajuste;
      renderMantendoLinha(state.ajusteModalMat);
    };
  });
  $('#main').querySelectorAll('[data-faltas]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      state.faltasModalMat = btn.dataset.faltas;
      renderMantendoLinha(state.faltasModalMat);
    };
  });
  const ovFaltas = $('#faltasModalOv');
  if (ovFaltas) {
    const fecharFaltas = () => { const mat = state.faltasModalMat; state.faltasModalMat = null; renderMantendoLinha(mat); };
    ovFaltas.onclick = fecharFaltas;
    $('#faltasModalBox').onclick = e => e.stopPropagation();
    $('#faltasModalFechar').onclick = fecharFaltas;
  }
  const btnPdf = $('#btnExportarCalculoPdf');
  if (btnPdf) btnPdf.onclick = () => window.print();
  const btnXlsx = $('#btnExportarCalculoXlsx');
  if (btnXlsx) btnXlsx.onclick = () => {
    const params = new URLSearchParams({
      apenasComProducao: f.apenasComProducao ? '1' : '0',
      especialidade: f.especialidade,
      departamento: f.departamento,
      nomes: state.exibirNomes ? '1' : '0',
    });
    // um "busca" por termo — o Excel sai igual ao que esta na tela
    for (const t of termosBuscaCalculo()) params.append('busca', t);
    window.open('/api/calculo/exportar?' + params.toString(), '_blank');
  };

  const ov = $('#ajusteModalOv');
  if (ov) {
    const fechar = () => { const mat = state.ajusteModalMat; state.ajusteModalMat = null; renderMantendoLinha(mat); };
    ov.onclick = fechar;
    $('#ajusteModalBox').onclick = e => e.stopPropagation();
    $('#ajusteModalFechar').onclick = fechar;
    $('#ajusteCancelar').onclick = fechar;
    $('#ajusteSalvar').onclick = async () => {
      const mat = state.ajusteModalMat;
      const pct = parseFloat($('#ajustePctInput').value);
      const obs = $('#ajusteObsInput').value.trim();
      if (Number.isNaN(pct)) { showToast('erro', 'Informe o percentual.'); return; }
      if (!obs) { showToast('erro', 'Informe a observação justificando o ajuste.'); return; }
      const btn = $('#ajusteSalvar');
      setBtnLoading(btn, true);
      try {
        if (podeSugerirAjuste()) {
          await api('/ajustes-pendentes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mat, pct, obs }) });
          state.ajusteModalMat = null;
          showToast('ok', 'Sugestão enviada para aprovação do Gerente e da Diretoria.');
          renderMantendoLinha(mat);
        } else {
          await api(`/ajuste/${encodeURIComponent(mat)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct, obs }) });
          state.ajusteModalMat = null;
          await carregarCalculo();
          renderMantendoLinha(mat);
          showToast('ok', 'Ajuste salvo.');
        }
      } catch (e) { showToast('erro', e.message); }
      finally { setBtnLoading(btn, false); }
    };
    const btnAjusteRemover = $('#ajusteRemover');
    if (btnAjusteRemover) btnAjusteRemover.onclick = async () => {
      const mat = state.ajusteModalMat;
      const btn = $('#ajusteRemover');
      setBtnLoading(btn, true);
      try {
        await api(`/ajuste/${encodeURIComponent(mat)}`, { method: 'DELETE' });
        state.ajusteModalMat = null;
        await carregarCalculo();
        renderMantendoLinha(mat);
        showToast('ok', 'Ajuste removido.');
      } catch (e) { showToast('erro', e.message); }
      finally { setBtnLoading(btn, false); }
    };
  }
}

/* =============== aba: aprovacoes =============== */
/* tem algo pra ser aprovado: valor a pagar vindo de producao registrada ou de
   ajuste manual (o ajuste existe justamente pra producao que o sistema nao
   capturou, entao esses tambem precisam passar pela aprovacao) */
const temValorAprovavel = k => k.gratif > 0 && (k.viagens > 0 || !!k.ajustePct);

function gratificacoesFiltradas() {
  const f = state.filtroAprovacoes;
  const meuPapel = USUARIO.papel;
  const lista = CALC ? CALC.lista : [];
  return lista
    .filter(k => {
      const info = GRATIF_APROVACOES[k.mat] || {};
      const jaAprovouEu = meuPapel === 'gerente' ? info.aprovadoGerente : info.aprovadoDiretoria;
      return (!f.soComValor || temValorAprovavel(k)) &&
        (!f.soComAjuste || k.ajustePct) &&
        (f.especialidade === 'TODOS' || k.espec === f.especialidade) &&
        (f.departamento === 'TODOS' || (k.departamento || 'Não informado') === f.departamento) &&
        (!f.busca || norm(k.nome).includes(norm(f.busca)) || String(k.mat).includes(f.busca)) &&
        (state.filtroAprovStatus === 'TODOS' ||
          (state.filtroAprovStatus === 'PENDENTES' && !jaAprovouEu) ||
          (state.filtroAprovStatus === 'APROVADOS' && jaAprovouEu));
    })
    .sort((a, b) => (b.ajustePct || 0) - (a.ajustePct || 0));
}

function renderAprovacoes() {
  if (!podeAprovar()) return placeholder('Aprovações');
  return renderGratificacoesAprovacao();
}
function renderGratificacoesAprovacao() {
  if (!CALC) return '';
  const f = state.filtroAprovacoes;
  const departamentos = [...new Set(CALC.lista.map(k => k.departamento || 'Não informado'))].sort();
  const lista = gratificacoesFiltradas();
  const linhasGratif = lista.map(k => {
    const info = GRATIF_APROVACOES[k.mat] || {};
    return `
    <tr>
      <td><input type="checkbox" class="chkGratif" value="${esc(k.mat)}"></td>
      <td class="mono">${esc(k.mat)}</td>
      <td>${state.exibirNomes ? esc(k.nome) : `Colaborador ${esc(k.mat)}`}</td>
      <td class="tag-sem">${esc(k.departamento || 'Não informado')}</td>
      <td>${badgeEspec(k.espec)}</td>
      <td class="num" style="font-weight:600">${numBR(k.gratif)}${!k.viagens ? '<div class="tag-sem" style="color:var(--ambar)" title="Nenhuma pesagem registrada no período — o valor vem do ajuste manual">sem produção registrada</div>' : ''}</td>
      <td class="num">${k.ajustePct ? `<span style="color:var(--azul);font-weight:600" title="${esc(k.ajusteObs || '')}">+${numBR(k.ajustePct, 1)}%</span>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="num" style="font-weight:600">${numBR(k.totalReceber)}</td>
      <td>
        <span class="tag-sem" style="color:${info.aprovadoGerente ? 'var(--verde)' : 'var(--muted)'}">${info.aprovadoGerente ? '✓' : '—'} Gerente${info.aprovadoGerentePor ? ' (' + esc(info.aprovadoGerentePor) + ')' : ''}</span><br>
        <span class="tag-sem" style="color:${info.aprovadoDiretoria ? 'var(--verde)' : 'var(--muted)'}">${info.aprovadoDiretoria ? '✓' : '—'} Diretoria${info.aprovadoDiretoriaPor ? ' (' + esc(info.aprovadoDiretoriaPor) + ')' : ''}</span>
      </td>
    </tr>`;
  }).join('');

  return `
    <div class="cartao">
      <div class="linha-form" style="justify-content:space-between">
        <div>
          <h2 style="margin:0">Aprovação das gratificações</h2>
          <div class="dica" style="margin:4px 0 0">${lista.length} colaborador${lista.length === 1 ? '' : 'es'} para revisão de Gerente e Diretoria${f.soComValor ? ` (de ${CALC.lista.length} no período — os demais não têm valor a pagar)` : ''}. Aprovar aqui é um sinal de "revisado e conferido" — não trava o valor, que continua calculado ao vivo. Cada papel pode desfazer o próprio voto quando quiser.</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input id="aprovBusca" placeholder="Buscar nome ou matrícula…" value="${esc(f.busca)}" style="width:200px">
          <select id="aprovEspec">
            <option value="TODOS" ${f.especialidade === 'TODOS' ? 'selected' : ''}>Todas especialidades</option>
            <option value="CAMINHAO" ${f.especialidade === 'CAMINHAO' ? 'selected' : ''}>Caminhão canavieiro</option>
            <option value="BATE-VOLTA" ${f.especialidade === 'BATE-VOLTA' ? 'selected' : ''}>Bate e volta</option>
            <option value="COLHEDORA" ${f.especialidade === 'COLHEDORA' ? 'selected' : ''}>Operador colhedora</option>
            <option value="TRANSBORDO" ${f.especialidade === 'TRANSBORDO' ? 'selected' : ''}>Operador transbordo</option>
          </select>
          <select id="aprovDepto">
            <option value="TODOS" ${f.departamento === 'TODOS' ? 'selected' : ''}>Todos os departamentos</option>
            ${departamentos.map(d => `<option value="${esc(d)}" ${f.departamento === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
          </select>
          <select id="aprovStatusFiltro">
            <option value="TODOS" ${state.filtroAprovStatus === 'TODOS' ? 'selected' : ''}>Todos os status</option>
            <option value="PENDENTES" ${state.filtroAprovStatus === 'PENDENTES' ? 'selected' : ''}>Pendentes da minha aprovação</option>
            <option value="APROVADOS" ${state.filtroAprovStatus === 'APROVADOS' ? 'selected' : ''}>Já aprovados por mim</option>
          </select>
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;white-space:nowrap" title="Esconde quem não tem valor a pagar no período (sem produção e sem ajuste)">
            <input type="checkbox" id="aprovSoComValor" ${f.soComValor ? 'checked' : ''}> Só com valor a aprovar
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;white-space:nowrap">
            <input type="checkbox" id="aprovSoAjuste" ${f.soComAjuste ? 'checked' : ''}> Só com ajuste manual
          </label>
        </div>
      </div>
      <div class="linha-form" style="margin-top:0">
        <button class="btn" id="btnAprovarGratifSelecionados">Aprovar selecionados</button>
        <button class="btn sec" id="btnDesfazerGratifSelecionados">Desfazer aprovação dos selecionados</button>
      </div>
      <div class="scroll-x">
        <table>
          <thead><tr>
            <th><input type="checkbox" id="chkTodosGratif"></th>
            <th>Mat.</th><th>Colaborador</th><th>Departamento</th><th>Espec.</th>
            <th class="num">Gratificação (R$)</th><th class="num">Ajuste manual</th><th class="num">Total (R$)</th><th>Aprovações</th>
          </tr></thead>
          <tbody>${linhasGratif || '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted)">Nenhum colaborador encontrado com esses filtros.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}
function wireAprovacoes() {
  if (!podeAprovar()) return;
  const fg = state.filtroAprovacoes;
  const aprovBusca = $('#aprovBusca');
  if (aprovBusca) aprovBusca.oninput = e => { fg.busca = e.target.value; renderPreservandoFoco(); };
  const aprovEspec = $('#aprovEspec');
  if (aprovEspec) aprovEspec.onchange = e => { fg.especialidade = e.target.value; render(); };
  const aprovDepto = $('#aprovDepto');
  if (aprovDepto) aprovDepto.onchange = e => { fg.departamento = e.target.value; render(); };
  const aprovSoAjuste = $('#aprovSoAjuste');
  if (aprovSoAjuste) aprovSoAjuste.onchange = e => { fg.soComAjuste = e.target.checked; render(); };
  const aprovSoComValor = $('#aprovSoComValor');
  if (aprovSoComValor) aprovSoComValor.onchange = e => { fg.soComValor = e.target.checked; render(); };
  const aprovStatusFiltro = $('#aprovStatusFiltro');
  if (aprovStatusFiltro) aprovStatusFiltro.onchange = e => { state.filtroAprovStatus = e.target.value; render(); };

  const chkTodosGratif = $('#chkTodosGratif');
  if (chkTodosGratif) chkTodosGratif.onchange = e => {
    document.querySelectorAll('.chkGratif').forEach(c => { c.checked = e.target.checked; });
  };
  const btnAprovarGratif = $('#btnAprovarGratifSelecionados');
  if (btnAprovarGratif) btnAprovarGratif.onclick = async () => {
    const mats = [...document.querySelectorAll('.chkGratif:checked')].map(c => c.value);
    if (!mats.length) { showToast('erro', 'Selecione ao menos um colaborador.'); return; }
    if (mats.length > 20 && !confirm(`Aprovar ${mats.length} colaboradores de uma vez, em seu nome (${USUARIO.papel})?`)) return;
    setBtnLoading(btnAprovarGratif, true);
    try {
      const r = await api('/gratificacoes/aprovar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mats }) });
      await carregarAprovacoesGratificacao();
      render();
      const n = (r && r.total) || mats.length;
      showToast('ok', `${n} colaborador${n > 1 ? 'es' : ''} aprovado${n > 1 ? 's' : ''}.`);
    } catch (e) { showToast('erro', e.message); }
    finally { setBtnLoading(btnAprovarGratif, false); }
  };
  const btnDesfazerGratif = $('#btnDesfazerGratifSelecionados');
  if (btnDesfazerGratif) btnDesfazerGratif.onclick = async () => {
    const mats = [...document.querySelectorAll('.chkGratif:checked')].map(c => c.value);
    if (!mats.length) { showToast('erro', 'Selecione ao menos um colaborador.'); return; }
    if (mats.length > 20 && !confirm(`Desfazer sua aprovação de ${mats.length} colaboradores de uma vez?`)) return;
    setBtnLoading(btnDesfazerGratif, true);
    try {
      const r = await api('/gratificacoes/desfazer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mats }) });
      await carregarAprovacoesGratificacao();
      render();
      const n = (r && r.total) || mats.length;
      showToast('ok', `Aprovação desfeita para ${n} colaborador${n > 1 ? 'es' : ''}.`);
    } catch (e) { showToast('erro', e.message); }
    finally { setBtnLoading(btnDesfazerGratif, false); }
  };
}

/* =============== aba: usuarios (so diretoria) =============== */
function renderUsuarios() {
  if (!ehDiretoria()) return placeholder('Usuários');
  const opcoesPapel = papelAtual => Object.keys(PAPEL_LABEL)
    .map(p => `<option value="${p}" ${p === papelAtual ? 'selected' : ''}>${PAPEL_LABEL[p]}</option>`).join('');
  const linhas = USUARIOS_LISTA.map(u => `
    <tr data-user-id="${u.id}">
      <td class="mono">${esc(u.username)}</td>
      <td>${esc(u.nome || '—')}</td>
      <td><select class="selPapel" data-id="${u.id}">${opcoesPapel(u.papel)}</select></td>
      <td><input type="checkbox" class="chkAtivo" data-id="${u.id}" ${u.ativo ? 'checked' : ''}></td>
      <td style="white-space:nowrap">
        <button type="button" class="btn peq sec" data-resetsenha="${u.id}">Redefinir senha</button>
        ${u.username !== USUARIO.username ? `<button type="button" class="btn peq sec" data-removeruser="${u.id}" style="color:var(--vermelho);border-color:var(--vermelho)">Remover</button>` : ''}
      </td>
    </tr>`).join('');

  return `
    <div class="cartao">
      <h2>Novo usuário</h2>
      <div class="linha-form">
        <div class="campo"><label>Usuário (login)</label><input id="novoUserUsername"></div>
        <div class="campo"><label>Nome</label><input id="novoUserNome"></div>
        <div class="campo"><label>Senha (mín. 6)</label><input id="novoUserSenha" type="password"></div>
        <div class="campo"><label>Papel</label>
          <select id="novoUserPapel">${opcoesPapel('usuario')}</select>
        </div>
        <button class="btn" id="btnCriarUsuario">Criar usuário</button>
      </div>
    </div>
    <div class="cartao">
      <h2>Usuários cadastrados</h2>
      <div class="scroll-x">
        <table>
          <thead><tr><th>Usuário</th><th>Nome</th><th>Papel</th><th>Ativo</th><th>Ações</th></tr></thead>
          <tbody>${linhas || '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--muted)">Nenhum usuário.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}
function wireUsuarios() {
  if (!ehDiretoria()) return;
  $('#btnCriarUsuario').onclick = async () => {
    const btn = $('#btnCriarUsuario');
    const username = $('#novoUserUsername').value.trim();
    const nome = $('#novoUserNome').value.trim();
    const senha = $('#novoUserSenha').value;
    const papel = $('#novoUserPapel').value;
    if (!username || senha.length < 6) { showToast('erro', 'Informe usuário e senha (mínimo 6 caracteres).'); return; }
    setBtnLoading(btn, true);
    try {
      await api('/usuarios', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, nome, senha, papel }) });
      await carregarUsuarios();
      render();
      showToast('ok', 'Usuário criado.');
    } catch (e) { showToast('erro', e.message); }
    finally { setBtnLoading(btn, false); }
  };
  document.querySelectorAll('.selPapel').forEach(sel => {
    sel.onchange = async () => {
      try {
        await api(`/usuarios/${sel.dataset.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ papel: sel.value }) });
        showToast('ok', 'Papel atualizado.');
      } catch (e) { showToast('erro', e.message); await carregarUsuarios(); render(); }
    };
  });
  document.querySelectorAll('.chkAtivo').forEach(chk => {
    chk.onchange = async () => {
      try {
        await api(`/usuarios/${chk.dataset.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo: chk.checked }) });
        showToast('ok', chk.checked ? 'Usuário reativado.' : 'Usuário desativado.');
      } catch (e) { showToast('erro', e.message); await carregarUsuarios(); render(); }
    };
  });
  document.querySelectorAll('[data-resetsenha]').forEach(btn => {
    btn.onclick = async () => {
      const senha = prompt('Nova senha para este usuário (mínimo 6 caracteres):');
      if (!senha) return;
      if (senha.length < 6) { showToast('erro', 'Senha deve ter ao menos 6 caracteres.'); return; }
      try {
        await api(`/usuarios/${btn.dataset.resetsenha}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha }) });
        showToast('ok', 'Senha redefinida.');
      } catch (e) { showToast('erro', e.message); }
    };
  });
  document.querySelectorAll('[data-removeruser]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Remover este usuário permanentemente?')) return;
      try {
        await api(`/usuarios/${btn.dataset.removeruser}`, { method: 'DELETE' });
        await carregarUsuarios();
        render();
        showToast('ok', 'Usuário removido.');
      } catch (e) { showToast('erro', e.message); }
    };
  });
}

/* =============== aba: historico (periodos fechados) =============== */
function historicoFiltrado() {
  const f = state.filtroHistorico;
  const lista = (FECHAMENTO_DETALHE && FECHAMENTO_DETALHE.colaboradores) || [];
  return lista.filter(k =>
    (f.especialidade === 'TODOS' || k.espec === f.especialidade) &&
    (f.departamento === 'TODOS' || (k.departamento || 'Não informado') === f.departamento) &&
    (!f.busca || norm(k.nome).includes(norm(f.busca)) || String(k.mat).includes(f.busca))
  );
}

function renderEvolucaoPeriodos() {
  if (!FECHAMENTOS.length) return '';
  /* ordem cronologica pra evolucao ser lida da esquerda pra direita */
  const ordem = [...FECHAMENTOS].sort((a, b) => a.periodo.inicio.localeCompare(b.periodo.inicio));
  const maxGratif = Math.max(1, ...ordem.map(f => f.resumo.gratif));
  /* grafico so faz sentido comparando periodos; com um so, a tabela ja diz tudo */
  const grafico = ordem.length > 1 ? `
      <div class="colunas" style="height:150px">
        ${ordem.map(f => `
          <div class="col" title="${esc(rotuloPeriodo(f.periodo))}">
            <div class="v">${numBR(f.resumo.gratif / 1000, 0)}k</div>
            <i style="height:${Math.round(Math.max(4, 108 * f.resumo.gratif / maxGratif))}px"></i>
            <div class="lab">${esc(brDate(f.periodo.inicio).slice(3))}</div>
          </div>`).join('')}
      </div>` : '';
  return `
    <div class="cartao">
      <h2>Evolução por período</h2>
      <div class="dica">${ordem.length > 1 ? 'Gratificação total de cada período já fechado.' : 'Assim que houver um segundo período fechado, a comparação entre eles aparece aqui.'}</div>
      ${grafico}
      <div class="scroll-x" style="margin-top:16px">
        <table>
          <thead><tr>
            <th>Período</th><th class="num">Colaboradores</th><th class="num">Toneladas</th><th class="num">Viagens</th>
            <th class="num">Gratificação (R$)</th><th class="num">Média/colab. (R$)</th><th class="num">Atingimento</th>
            <th class="num">Ajustes (R$)</th><th class="num">Salário + gratif. (R$)</th><th>Fechado</th>
          </tr></thead>
          <tbody>${[...FECHAMENTOS].map(f => {
            const r = f.resumo;
            const atend = r.teto > 0 ? 100 * r.gratif / r.teto : 0;
            return `
            <tr class="linha-clic" data-verperiodo="${esc(chavePeriodo(f.periodo))}">
              <td><b>${esc(rotuloPeriodo(f.periodo))}</b></td>
              <td class="num">${r.colaboradores}</td>
              <td class="num">${numBR(r.ton, 0)}</td>
              <td class="num">${r.viagens.toLocaleString('pt-BR')}</td>
              <td class="num" style="font-weight:600;color:var(--verde-esc)">${numBR(r.gratif, 0)}</td>
              <td class="num">${numBR(r.colaboradores ? r.gratif / r.colaboradores : 0, 0)}</td>
              <td class="num">${numBR(atend, 1)}%</td>
              <td class="num" style="color:var(--azul)">${r.ajusteValor ? '+' + numBR(r.ajusteValor, 0) : '—'}</td>
              <td class="num">${numBR(r.totalReceber, 0)}</td>
              <td class="tag-sem">${esc((f.fechadoEm || '').slice(0, 10).split('-').reverse().join('/'))} · ${esc(f.fechadoPor || '—')}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

function renderHistorico() {
  if (!FECHAMENTOS.length) {
    return `<div class="cartao"><h2>Histórico</h2><div class="dica">Nenhum período fechado ainda. Feche um período na aba Dados para ele aparecer aqui.</div></div>`;
  }
  const f = state.filtroHistorico;
  const snap = FECHAMENTO_DETALHE;
  if (!snap) return renderEvolucaoPeriodos();

  const lista = historicoFiltrado();
  const departamentos = [...new Set(snap.colaboradores.map(k => k.departamento || 'Não informado'))].sort();
  /* snapshots antigos foram gravados antes de o fechamento passar a guardar a
     quebra semanal — da pra completar reimportando as pesagens do periodo */
  const temDetalhe = snap.colaboradores.some(k => k.semanas && Object.keys(k.semanas).length);
  const periodoBate = DADOS.periodo.inicio === snap.periodo.inicio && DADOS.periodo.fim === snap.periodo.fim;
  const avisoDetalhe = temDetalhe ? '' : `
    <div class="aviso alerta" style="margin-top:12px">
      <b>Sem detalhe semanal.</b> Este período foi fechado antes do sistema passar a guardar a quebra por semana, as frotas e os dias sem expediente — por isso o extrato dele vem resumido.
      ${podeAprovar() ? `Para completar: deixe o período de apuração em ${esc(rotuloPeriodo(snap.periodo))}, reimporte a planilha de pesagens desse mês na aba Dados e clique abaixo. Os valores de gratificação, teto, ajuste e total <b>não são recalculados</b> — continuam os que foram congelados no fechamento.
        <div class="linha-form" style="margin:10px 0 0">
          <button class="btn sec" id="btnCompletarDetalhe" ${periodoBate && DADOS.pesagens.length ? '' : 'disabled'}>Completar detalhe semanal</button>
          ${!periodoBate ? `<span class="tag-sem">Período atual está em ${esc(rotuloPeriodo(DADOS.periodo))}.</span>`
            : !DADOS.pesagens.length ? '<span class="tag-sem">Nenhuma pesagem carregada na aba Dados.</span>' : ''}
        </div>` : ''}
    </div>`;
  const resumo = lista.reduce((acc, k) => {
    acc.n++; acc.ton += k.ton || 0; acc.gratif += k.gratif || 0; acc.teto += k.tetoEfetivo ?? k.teto ?? 0;
    acc.totalReceber += k.totalReceber || 0; acc.ajusteValor += k.ajusteValor || 0;
    return acc;
  }, { n: 0, ton: 0, gratif: 0, teto: 0, totalReceber: 0, ajusteValor: 0 });
  const atingMedio = resumo.teto > 0 ? 100 * resumo.gratif / resumo.teto : 0;

  return `
    ${renderEvolucaoPeriodos()}
    <div class="cartao">
      <div class="linha-form" style="justify-content:space-between">
        <div>
          <h2 style="margin:0">Período fechado — ${esc(rotuloPeriodo(snap.periodo))}</h2>
          <div class="dica" style="margin:4px 0 0">Fechado em ${esc((snap.fechadoEm || '').slice(0, 10).split('-').reverse().join('/'))} por ${esc(snap.fechadoPor || '—')} · dias-base ${snap.diasBase}. Valores congelados: não mudam com importações novas.</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <select id="histPeriodo">
            ${FECHAMENTOS.map(x => `<option value="${esc(chavePeriodo(x.periodo))}" ${chavePeriodo(x.periodo) === f.chave ? 'selected' : ''}>${esc(rotuloPeriodo(x.periodo))}</option>`).join('')}
          </select>
          <input id="histBusca" placeholder="Buscar nome ou matrícula…" value="${esc(f.busca)}" style="width:200px">
          <select id="histEspec">
            <option value="TODOS" ${f.especialidade === 'TODOS' ? 'selected' : ''}>Todas especialidades</option>
            <option value="CAMINHAO" ${f.especialidade === 'CAMINHAO' ? 'selected' : ''}>Caminhão canavieiro</option>
            <option value="BATE-VOLTA" ${f.especialidade === 'BATE-VOLTA' ? 'selected' : ''}>Bate e volta</option>
            <option value="COLHEDORA" ${f.especialidade === 'COLHEDORA' ? 'selected' : ''}>Operador colhedora</option>
            <option value="TRANSBORDO" ${f.especialidade === 'TRANSBORDO' ? 'selected' : ''}>Operador transbordo</option>
          </select>
          <select id="histDepto">
            <option value="TODOS" ${f.departamento === 'TODOS' ? 'selected' : ''}>Todos os departamentos</option>
            ${departamentos.map(d => `<option value="${esc(d)}" ${f.departamento === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
          </select>
          <button class="btn sec no-print" id="btnExportarHistorico">Exportar Excel</button>
        </div>
      </div>
      ${avisoDetalhe}
      <div class="kpis" style="margin-top:12px">
        <div class="kpi"><div class="rot">Colaboradores</div><div class="val">${resumo.n}</div><div class="det">no filtro atual</div></div>
        <div class="kpi"><div class="rot">Toneladas</div><div class="val">${numBR(resumo.ton, 0)}</div><div class="det">no período</div></div>
        <div class="kpi"><div class="rot">Gratificação (R$)</div><div class="val">${numBR(resumo.gratif, 0)}</div><div class="det">valor congelado</div></div>
        <div class="kpi"><div class="rot">Atingimento médio</div><div class="val">${numBR(atingMedio, 1)}%</div><div class="det">R$ ${numBR(resumo.gratif, 0)} de R$ ${numBR(resumo.teto, 0)}</div></div>
        <div class="kpi"><div class="rot">Média por colaborador (R$)</div><div class="val">${numBR(resumo.n ? resumo.gratif / resumo.n : 0, 0)}</div><div class="det">no filtro atual</div></div>
        ${resumo.ajusteValor ? `<div class="kpi" style="border-top-color:var(--azul)"><div class="rot">Ajustes manuais (R$)</div><div class="val" style="color:var(--azul)">+${numBR(resumo.ajusteValor, 0)}</div><div class="det">já embutidos na gratificação</div></div>` : ''}
        <div class="kpi"><div class="rot">Salário + gratificação</div><div class="val">${numBR(resumo.totalReceber, 0)}</div><div class="det">sem HE e DSR</div></div>
      </div>
      <div class="scroll-x tabela-calc">
        <table style="width:1320px">
          <thead><tr>
            <th style="width:70px">Mat.</th><th style="width:170px">Colaborador</th><th style="width:160px">Departamento</th><th style="width:95px">Espec.</th>
            <th class="num" style="width:70px">Viagens</th><th class="num" style="width:80px">Ton</th><th class="num" style="width:70px">Km méd.</th>
            <th class="num" style="width:95px">Salário base</th><th class="num" style="width:100px">Gratificação (R$)</th>
            <th class="num" style="width:80px">Teto (R$)</th><th style="width:110px">% Atingido</th><th class="num" style="width:95px">Total (R$)</th>
            <th style="width:110px">Aprovações</th><th class="col-acoes" style="width:95px">Ações</th>
          </tr></thead>
          <tbody>${lista.length ? lista.map(k => `
            <tr data-mat="${esc(k.mat)}">
              <td class="mono">${esc(k.mat)}</td>
              <td>${state.exibirNomes ? esc(k.nome) : `Colaborador ${esc(k.mat)}`}<div class="tag-sem">${esc(k.funcao || '')}</div></td>
              <td class="tag-sem">${esc(k.departamento || 'Não informado')}</td>
              <td>${badgeEspec(k.espec)}</td>
              <td class="num">${k.viagens}</td>
              <td class="num">${numBR(k.ton, 1)}</td>
              <td class="num">${k.kmMed ? numBR(k.kmMed, 0) : '—'}</td>
              <td class="num">${numBR(k.sal)}</td>
              <td class="num" style="font-weight:600;color:var(--verde-esc)">${numBR(k.gratif)}</td>
              <td class="num">${numBR(k.tetoEfetivo ?? k.teto, 0)}${(k.tetoEfetivo ?? k.teto) < k.teto ? '<span class="tag-sem" style="margin-left:3px">pr</span>' : ''}</td>
              <td><div style="display:flex;align-items:center;gap:6px">
                <div class="barra" style="width:70px"><i class="${k.atingPct > 1 ? 'acima' : ''}" style="width:${Math.min(100, (k.atingPct || 0) * 100)}%"></i></div>
                <span class="mono" style="font-size:11.5px">${numBR((k.atingPct || 0) * 100, 1)}%</span>
                ${k.ajustePct ? `<span class="tag-sem" style="color:var(--azul)" title="${esc(k.ajusteObs || '')}">+${numBR(k.ajustePct, 1)}%</span>` : ''}
              </div></td>
              <td class="num" style="font-weight:600">${numBR(k.totalReceber)}</td>
              <td class="tag-sem">${k.aprovadoGerentePor ? `✓ ${esc(k.aprovadoGerentePor)}` : '— Gerente'}<br>${k.aprovadoDiretoriaPor ? `✓ ${esc(k.aprovadoDiretoriaPor)}` : '— Diretoria'}</td>
              <td class="col-acoes"><button type="button" class="btn peq sec" data-histextrato="${esc(k.mat)}">📄 Extrato</button></td>
            </tr>`).join('') : '<tr><td colspan="14" style="text-align:center;padding:24px;color:var(--muted)">Nenhum colaborador com esses filtros.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function exportarHistoricoCsv() {
  const snap = FECHAMENTO_DETALHE;
  if (!snap) return;
  const cab = ['Matrícula', ...(state.exibirNomes ? ['Nome'] : []), 'Função', 'Departamento', 'Especialidade',
    'Viagens', 'Toneladas', 'Km méd.', 'Salário base R$', 'Gratificação R$', 'Teto R$', '% Atingido',
    'Ajuste manual %', 'Observação do ajuste', 'Total a receber R$', 'Aprovado Gerente', 'Aprovado Diretoria'];
  const linhas = [cab];
  for (const k of historicoFiltrado()) {
    linhas.push([k.mat, ...(state.exibirNomes ? [k.nome] : []), k.funcao || '', k.departamento || '', k.espec,
      k.viagens, numBR(k.ton, 1), k.kmMed ? numBR(k.kmMed, 0) : '', numBR(k.sal), numBR(k.gratif),
      numBR(k.tetoEfetivo ?? k.teto, 0), numBR((k.atingPct || 0) * 100, 1) + '%',
      k.ajustePct ? numBR(k.ajustePct, 1) : '', k.ajusteObs || '', numBR(k.totalReceber),
      k.aprovadoGerentePor || '', k.aprovadoDiretoriaPor || '']);
  }
  const csv = linhas.map(l => l.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `gratificacao_${snap.periodo.inicio}_a_${snap.periodo.fim}.csv`;
  a.click();
}

function wireHistorico() {
  const f = state.filtroHistorico;
  const sel = $('#histPeriodo');
  if (sel) sel.onchange = async e => {
    f.chave = e.target.value;
    $('#main').innerHTML = '<div class="cartao"><div class="dica">Carregando período…</div></div>';
    try { await carregarFechamentoDetalhe(f.chave); } catch (err) { showToast('erro', err.message); }
    render();
  };
  const busca = $('#histBusca');
  if (busca) busca.oninput = e => { f.busca = e.target.value; renderPreservandoFoco(); };
  const espec = $('#histEspec');
  if (espec) espec.onchange = e => { f.especialidade = e.target.value; render(); };
  const depto = $('#histDepto');
  if (depto) depto.onchange = e => { f.departamento = e.target.value; render(); };
  const btnExp = $('#btnExportarHistorico');
  if (btnExp) btnExp.onclick = exportarHistoricoCsv;

  const btnCompletar = $('#btnCompletarDetalhe');
  if (btnCompletar) btnCompletar.onclick = async () => {
    const p = FECHAMENTO_DETALHE.periodo;
    if (!confirm(`Completar o detalhe semanal de ${rotuloPeriodo(p)} usando as pesagens carregadas agora?\n\n` +
      `Só serão acrescentadas as semanas, frotas e faltas. Gratificação, teto, ajuste e total continuam os valores congelados no fechamento.`)) return;
    setBtnLoading(btnCompletar, true);
    try {
      const r = await api(`/fechamentos/${p.inicio}/${p.fim}/enriquecer`, { method: 'POST' });
      FECHAMENTO_DETALHE = null;
      await carregarFechamentoDetalhe(f.chave);
      render();
      showToast('ok', `Detalhe completado para ${r.completados} colaborador${r.completados > 1 ? 'es' : ''}${r.semDados ? ` · ${r.semDados} sem correspondência nas pesagens` : ''}.`);
    } catch (e) { showToast('erro', e.message); setBtnLoading(btnCompletar, false); }
  };

  $('#main').querySelectorAll('[data-verperiodo]').forEach(tr => {
    tr.onclick = async () => {
      f.chave = tr.dataset.verperiodo;
      try { await carregarFechamentoDetalhe(f.chave); } catch (err) { showToast('erro', err.message); }
      render();
    };
  });
  /* abre o extrato completo (mesma tela do periodo aberto) em cima do snapshot
     deste periodo fechado, em vez do resumo em modal */
  $('#main').querySelectorAll('[data-histextrato]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      state.extratoFechamento = f.chave;
      state.extratoMat = btn.dataset.histextrato;
      state.extratoSemanaAberta = null;
      state.extratoRelatorioIntervalo = null;
      state.extratoRelatorioModalAberto = false;
      setView('extrato');
    };
  });
}

/* =============== aba: dados =============== */
function renderDados() {
  const d = DADOS;
  const periodoBloco = podeAdministrar() ? `
    <div class="cartao">
      <h2>Período de apuração</h2>
      <div class="dica">Define o intervalo usado nos cálculos e nos dados de demonstração.</div>
      <div class="linha-form">
        <div class="campo"><label>Início</label><input type="date" id="f_inicio" value="${esc(d.periodo.inicio || '')}"></div>
        <div class="campo"><label>Fim</label><input type="date" id="f_fim" value="${esc(d.periodo.fim || '')}"></div>
        <div class="campo"><label>Dias-base (jornada completa)</label><input type="number" id="f_diasBase" min="1" max="31" value="${d.diasBase}"></div>
        <button class="btn" id="btnSalvarPeriodo">Salvar período</button>
      </div>
    </div>` : `
    <div class="cartao">
      <h2>Período de apuração</h2>
      <div class="dica">Período de ${brDate(d.periodo.inicio)} a ${brDate(d.periodo.fim)} · dias-base ${d.diasBase}. Somente Gerente/Diretoria podem alterar.</div>
    </div>`;

  /* botao de apagar so daquela base — permite subir arquivo novo sem derrubar
     as outras. So Gerente/Diretoria, igual ao "Limpar tudo". */
  const btnApagar = (base, rotulo, qtd) => podeAdministrar() && qtd
    ? `<button type="button" class="btn peq sec" data-apagarbase="${base}" data-rotulo="${esc(rotulo)}" style="color:var(--vermelho);border-color:var(--vermelho);margin-top:10px">Apagar ${esc(rotulo)}</button>`
    : '';

  const importBloco = podeImportar() ? `
    <div class="grade2">
      <div class="cartao">
        <h2>Funcionários / motoristas</h2>
        <div class="dica">Busca direto do sistema da empresa (mesma base do RH) — matrícula, nome, função, departamento e admissão dos colaboradores ativos. Sem upload de planilha: é só clicar pra atualizar.</div>
        <button class="btn sec" id="btnAtualizarFuncionarios">Atualizar funcionários</button>
        ${d.funcionarios.length ? `<div class="tag-sem" style="margin-top:8px">${d.funcionarios.length} carregados${d.funcionariosAtualizadoEm ? ` · atualizado ${tempoRelativo(d.funcionariosAtualizadoEm)}` : ''}.</div>` : ''}
        ${btnApagar('funcionarios', 'funcionários', d.funcionarios.length)}
      </div>
      <div class="cartao">
        <h2>Disponibilidade de frotas</h2>
        <div class="dica">Relatório com colunas Frota, Descrição e % de disponibilidade.</div>
        <label class="zona" id="zonaFrotas"><b>Clique para escolher o arquivo</b><br>ou arraste o .xlsx aqui
          <input type="file" id="f_frotas" accept=".xlsx" style="display:none">
        </label>
        ${d.frotas.length ? `<div class="tag-sem" style="margin-top:8px">${d.frotas.length} frotas carregadas.</div>` : ''}
        ${btnApagar('frotas', 'disponibilidade', d.frotas.length)}
      </div>
    </div>

    <div class="cartao">
      <h2>Pesagens / produção</h2>
      <div class="dica">Planilha com matrícula, data, peso, km/raio e frota de cada viagem. Cada importação substitui a anterior — use "Apagar pesagens" se quiser zerar antes de subir um arquivo novo.</div>
      <label class="zona" id="zonaPesagens"><b>Clique para escolher o arquivo</b><br>ou arraste o .xlsx aqui
        <input type="file" id="f_pesagens" accept=".xlsx" style="display:none">
      </label>
      ${d.pesagens.length ? `<div class="tag-sem" style="margin-top:8px">${d.pesagens.length.toLocaleString('pt-BR')} pesagens carregadas.</div>` : ''}
      ${btnApagar('pesagens', 'pesagens', d.pesagens.length)}
    </div>

    <div class="cartao">
      <h2>Jornada / escala</h2>
      <div class="dica">Busca a escala direto do sistema da empresa (mesma base do RH) pro período de apuração atual — usado pra mostrar, no Cálculo, os dias sem expediente (D.S.R., feriado, férias, atestado, compensado) de cada colaborador. Sem upload de planilha: é só clicar pra atualizar.</div>
      <button class="btn sec" id="btnAtualizarJornada">Atualizar jornada</button>
      ${d.jornadaResumo && d.jornadaResumo.registros ? `<div class="tag-sem" style="margin-top:8px">Carregado: ${d.jornadaResumo.registros} dias sem expediente em ${d.jornadaResumo.matriculas} matrículas${d.jornadaResumo.atualizadoEm ? ` · atualizado ${tempoRelativo(d.jornadaResumo.atualizadoEm)}` : ''}.</div>` : ''}
      ${btnApagar('jornada', 'jornada', (d.jornadaResumo && d.jornadaResumo.matriculas) || 0)}
    </div>` : '';

  const acoesResumo = podeImportar() ? `
      <div class="linha-form" style="margin-bottom:14px">
        ${podeImportar() ? '<button class="btn sec" id="btnDemo">Carregar dados de demonstração</button>' : ''}
        ${podeAdministrar() ? '<button class="btn sec" id="btnLimpar" style="color:var(--vermelho);border-color:var(--vermelho)">Limpar tudo</button>' : ''}
      </div>` : '';

  const fechados = FECHAMENTOS || [];
  const fechamentoBloco = podeImportar() ? `
    <div class="cartao">
      <h2>Fechamento do período</h2>
      <div class="dica">Congela a gratificação de <b>${brDate(d.periodo.inicio)} a ${brDate(d.periodo.fim)}</b> num histórico permanente e já deixa a tela pronta pro próximo período. Ao fechar: a gratificação de cada colaborador fica salva, as pesagens, a disponibilidade de frotas, a jornada e os ajustes manuais do período são limpos, e o período avança automaticamente. As aprovações de cada mês ficam guardadas separadamente.</div>
      ${ehDiretoria()
        ? '<button class="btn" id="btnFecharPeriodo">Fechar período e abrir o próximo</button>'
        : '<div class="tag-sem">Somente a Diretoria pode fechar o período.</div>'}
      ${fechados.length ? `
        <div style="margin-top:16px">
          <div class="tag-sem" style="margin-bottom:6px">Períodos já fechados</div>
          <div class="scroll-x">
            <table>
              <thead><tr><th>Período</th><th class="num">Colaboradores</th><th class="num">Toneladas</th><th class="num">Gratificação (R$)</th><th class="num">Salário + gratif. (R$)</th><th>Fechado</th></tr></thead>
              <tbody>${fechados.map(f => `
                <tr>
                  <td>${brDate(f.periodo.inicio)} a ${brDate(f.periodo.fim)}</td>
                  <td class="num">${f.resumo.colaboradores}</td>
                  <td class="num">${numBR(f.resumo.ton, 0)}</td>
                  <td class="num" style="font-weight:600;color:var(--verde-esc)">${numBR(f.resumo.gratif, 0)}</td>
                  <td class="num">${numBR(f.resumo.totalReceber, 0)}</td>
                  <td class="tag-sem">${esc((f.fechadoEm || '').slice(0, 10).split('-').reverse().join('/'))} por ${esc(f.fechadoPor || '—')}</td>
                </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>` : ''}
    </div>` : '';

  return `
    ${periodoBloco}
    ${importBloco}
    <div class="cartao">
      <h2>Resumo atual</h2>
      ${acoesResumo}
      <div class="kpis">
        <div class="kpi"><div class="rot">Funcionários</div><div class="val">${d.funcionarios.length}</div></div>
        <div class="kpi"><div class="rot">Pesagens</div><div class="val">${d.pesagens.length}</div></div>
        <div class="kpi"><div class="rot">Frotas (disponibilidade)</div><div class="val">${d.frotas.length}</div></div>
      </div>
    </div>
    ${fechamentoBloco}`;
}
function wireDados() {
  const btnSalvarPeriodo = $('#btnSalvarPeriodo');
  if (btnSalvarPeriodo) btnSalvarPeriodo.onclick = async () => {
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

  const upload = (inputId, zonaId, endpoint, titulo, labelOk) => {
    const el = $(inputId);
    if (!el) return;
    const processar = async arquivo => {
      if (!arquivo) return;
      abrirModalProgresso(titulo, arquivo);
      try {
        const r = await enviarArquivoComProgresso(endpoint, arquivo);
        atualizarProgresso({ indeterminada: true, texto: 'Atualizando a tela…' });
        await carregarDados();
        fecharModalProgresso();
        render();
        showToast('ok', labelOk(r));
      } catch (err) {
        fecharModalProgresso();
        showToast('erro', err.message);
      }
    };
    el.onchange = async e => {
      await processar(e.target.files[0]);
      e.target.value = '';
    };
    const zona = $(zonaId);
    if (!zona) return;
    ['dragenter', 'dragover'].forEach(evt => zona.addEventListener(evt, e => {
      e.preventDefault(); e.stopPropagation();
      zona.classList.add('arrastando');
    }));
    ['dragleave', 'dragend', 'drop'].forEach(evt => zona.addEventListener(evt, e => {
      e.preventDefault(); e.stopPropagation();
      zona.classList.remove('arrastando');
    }));
    zona.addEventListener('drop', e => processar(e.dataTransfer.files[0]));
  };
  upload('#f_frotas', '#zonaFrotas', '/import/frotas', 'Importando disponibilidade de frotas', r => `Disponibilidade importada: ${r.total} frotas.`);
  upload('#f_pesagens', '#zonaPesagens', '/import/pesagens', 'Importando pesagens / produção', r => r.temKm
    ? `${r.total} pesagens importadas de "${r.nomeArquivo}".`
    : `${r.total} pesagens importadas, mas a coluna de km/raio não foi encontrada — km vai ficar zerado.`);

  $('#main').querySelectorAll('[data-apagarbase]').forEach(btn => {
    btn.onclick = async () => {
      const base = btn.dataset.apagarbase, rotulo = btn.dataset.rotulo;
      if (!confirm(`Apagar os dados de ${rotulo}? As outras bases continuam como estão.`)) return;
      setBtnLoading(btn, true);
      try {
        await api(`/dados/${base}`, { method: 'DELETE' });
        await carregarDados();
        render();
        showToast('ok', `Dados de ${rotulo} apagados.`);
      } catch (e) { showToast('erro', e.message); setBtnLoading(btn, false); }
    };
  });

  const btnFechar = $('#btnFecharPeriodo');
  if (btnFechar) btnFechar.onclick = async () => {
    const p = DADOS.periodo;
    if (!confirm(`Fechar a gratificação de ${brDate(p.inicio)} a ${brDate(p.fim)}?\n\n` +
      `• A gratificação de cada colaborador fica salva no histórico\n` +
      `• Pesagens, frotas, jornada e ajustes manuais do período são limpos\n` +
      `• O período avança para o mês seguinte\n\n` +
      `Isso não pode ser desfeito pela tela.`)) return;
    setBtnLoading(btnFechar, true);
    try {
      const r = await api('/fechamento', { method: 'POST' });
      await carregarDados();
      await carregarFechamentos();
      CALC = null;
      render();
      showToast('ok', `Período fechado: ${r.resumo.colaboradores} colaboradores e R$ ${numBR(r.resumo.gratif, 0)} salvos. Novo período: ${brDate(r.novoPeriodo.inicio)} a ${brDate(r.novoPeriodo.fim)}.`);
    } catch (e) { showToast('erro', e.message); }
    finally { setBtnLoading(btnFechar, false); }
  };

  const btnFuncionarios = $('#btnAtualizarFuncionarios');
  if (btnFuncionarios) btnFuncionarios.onclick = async () => {
    setBtnLoading(btnFuncionarios, true);
    try {
      const r = await api('/funcionarios/atualizar', { method: 'POST' });
      await carregarDados();
      render();
      showToast('ok', `${r.total} funcionários atualizados.`);
    } catch (err) { showToast('erro', err.message); }
    finally { setBtnLoading(btnFuncionarios, false); }
  };

  const btnJornada = $('#btnAtualizarJornada');
  if (btnJornada) btnJornada.onclick = async () => {
    setBtnLoading(btnJornada, true);
    const consultar = async () => {
      let st;
      try { st = await api('/import/jornada/status'); } catch (err) { showToast('erro', err.message); setBtnLoading(btnJornada, false); return; }
      if (st.status === 'processando') { setTimeout(consultar, 3000); return; }
      setBtnLoading(btnJornada, false);
      if (st.status === 'erro') { showToast('erro', st.mensagem); return; }
      await carregarDados();
      render();
      showToast('ok', `${st.totalRegistros} dias sem expediente em ${st.totalMatriculas} matrículas.`);
    };
    try {
      await api('/jornada/atualizar', { method: 'POST' });
      showToast('ok', 'Buscando jornada no sistema da empresa — processando em segundo plano…');
      setTimeout(consultar, 3000);
    } catch (err) { showToast('erro', err.message); setBtnLoading(btnJornada, false); }
  };

  const btnDemo = $('#btnDemo');
  if (btnDemo) btnDemo.onclick = async () => {
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

  const btnLimpar = $('#btnLimpar');
  if (btnLimpar) btnLimpar.onclick = async () => {
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

/* =============== autenticacao / papeis =============== */
let USUARIO = null;

function podeEscrever(...papeis) { return !!USUARIO && papeis.includes(USUARIO.papel); }
const podeImportar = () => podeEscrever('coordenador', 'gerente', 'diretoria');
const podeAdministrar = () => podeEscrever('gerente', 'diretoria');
const podeSugerirAjuste = () => podeEscrever('coordenador');
const podeAprovar = () => podeEscrever('gerente', 'diretoria');
const ehDiretoria = () => podeEscrever('diretoria');

const PAPEL_LABEL = { usuario: 'Usuário', coordenador: 'Coordenador', gerente: 'Gerente', diretoria: 'Diretoria' };

function renderUsuarioSessao() {
  if (!USUARIO) return '';
  return `<b>${esc(USUARIO.nome || USUARIO.username)}</b><span class="papel-tag">${esc(PAPEL_LABEL[USUARIO.papel] || USUARIO.papel)}</span><button class="btn-sair" id="btnSair">Sair</button>`;
}

function aplicarVisibilidadePorPapel() {
  const mostrar = {
    dados: true, parametros: podeAdministrar(), calculo: true, semanal: true, diretoria: true, extrato: true,
    historico: true, aprovacoes: podeAprovar(), usuarios: ehDiretoria(),
  };
  document.querySelectorAll('.aba').forEach(b => { b.style.display = mostrar[b.dataset.v] === false ? 'none' : ''; });
}

function renderLoginScreen(erro) {
  $('#appShell').style.display = 'none';
  const authShell = $('#authShell');
  authShell.style.display = 'flex';
  authShell.innerHTML = `
    <div class="auth-caixa">
      <div class="cartao" style="max-width:360px;width:100%">
        <div style="text-align:center;margin-bottom:14px">
          <img src="/static/assets/logo_crv.png" alt="CRV Industrial" style="height:44px">
          <h2 style="margin:10px 0 0">Gratificação CTT</h2>
          <div class="dica">Entre com seu usuário e senha</div>
        </div>
        ${erro ? `<div class="aviso erro" style="display:block;margin-bottom:10px">${esc(erro)}</div>` : ''}
        <div class="campo" style="margin-bottom:10px"><label>Usuário</label><input id="loginUser" style="width:100%"></div>
        <div class="campo" style="margin-bottom:14px"><label>Senha</label><input id="loginSenha" type="password" style="width:100%"></div>
        <button class="btn" id="btnLogin" style="width:100%">Entrar</button>
      </div>
    </div>`;
  $('#btnLogin').onclick = fazerLogin;
  authShell.querySelectorAll('input').forEach(inp => inp.onkeydown = e => { if (e.key === 'Enter') fazerLogin(); });
  $('#loginUser').focus();
}

async function fazerLogin() {
  const username = $('#loginUser').value.trim();
  const senha = $('#loginSenha').value;
  if (!username || !senha) { renderLoginScreen('Informe usuário e senha.'); return; }
  const btn = $('#btnLogin');
  setBtnLoading(btn, true);
  try {
    USUARIO = await api('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, senha }) });
    await iniciarApp();
  } catch (e) {
    renderLoginScreen(e.message);
  } finally { setBtnLoading(btn, false); }
}

function renderBootstrapScreen(erro) {
  $('#appShell').style.display = 'none';
  const authShell = $('#authShell');
  authShell.style.display = 'flex';
  authShell.innerHTML = `
    <div class="auth-caixa">
      <div class="cartao" style="max-width:400px;width:100%">
        <h2>Configuração inicial</h2>
        <div class="dica">Nenhum usuário cadastrado ainda. Crie a primeira conta (Diretoria) para começar a usar o sistema.</div>
        ${erro ? `<div class="aviso erro" style="display:block;margin:10px 0 0">${esc(erro)}</div>` : ''}
        <div class="campo" style="margin:10px 0"><label>Seu nome</label><input id="bsNome" style="width:100%"></div>
        <div class="campo" style="margin-bottom:10px"><label>Usuário (login)</label><input id="bsUser" style="width:100%"></div>
        <div class="campo" style="margin-bottom:14px"><label>Senha (mín. 6 caracteres)</label><input id="bsSenha" type="password" style="width:100%"></div>
        <button class="btn" id="btnBootstrap" style="width:100%">Criar conta e entrar</button>
      </div>
    </div>`;
  $('#btnBootstrap').onclick = async () => {
    const btn = $('#btnBootstrap');
    setBtnLoading(btn, true);
    try {
      USUARIO = await api('/bootstrap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: $('#bsNome').value.trim(), username: $('#bsUser').value.trim(), senha: $('#bsSenha').value }),
      });
      await iniciarApp();
    } catch (e) {
      renderBootstrapScreen(e.message);
    } finally { setBtnLoading(btn, false); }
  };
}

async function iniciarApp() {
  $('#authShell').style.display = 'none';
  $('#appShell').style.display = '';
  $('#usuarioSessao').innerHTML = renderUsuarioSessao();
  $('#btnSair').onclick = async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    USUARIO = null;
    renderLoginScreen();
  };
  aplicarVisibilidadePorPapel();
  await Promise.all([carregarDados(), carregarParametros()]);
  setView('dados');
}

/* =============== boot =============== */
(async () => {
  try {
    const boot = await api('/precisa-bootstrap');
    if (boot.precisaBootstrap) { renderBootstrapScreen(); return; }
    USUARIO = await api('/me');
    await iniciarApp();
  } catch (e) {
    renderLoginScreen();
  }
})();

'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brl = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const numBR = (n, casas = 2) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const norm = s => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();
const brDate = iso => iso ? iso.split('-').reverse().join('/') : '—';
const dataCurta = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

/* =============== estado =============== */
const state = {
  view: 'dados',
  exibirNomes: false,
  extratoMat: null,
  extratoSemanaAberta: null,
  ajusteModalMat: null,
  /* cada aba com filtro proprio tem seu objeto isolado — nao ha estado de
     filtro global compartilhado entre abas (evita o painel da diretoria, ou
     qualquer outra aba, herdar o filtro aplicado em outra) */
  filtroCalculo: { busca: '', apenasComProducao: true, especialidade: 'TODOS', departamento: 'TODOS', detalheAberto: null },
  filtroSemanal: { semana: 'TODAS', departamento: 'TODOS' },
  filtroDiretoria: { especialidade: 'TODOS', departamento: 'TODOS' },
};

/* dados carregados do backend (funcionarios/pesagens/frotas/periodo) */
let DADOS = { funcionarios: [], pesagens: [], frotas: [], periodo: { inicio: null, fim: null }, diasBase: 25 };
let PARAMS = null;
let CALC = null;

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

async function carregarParametros() {
  PARAMS = await api('/parametros');
}

async function carregarCalculo() {
  CALC = await api('/calculo');
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
const VIEWS_QUE_USAM_CALCULO = new Set(['calculo', 'semanal', 'diretoria', 'extrato']);
async function setView(v) {
  state.view = v;
  document.querySelectorAll('.aba').forEach(b => b.classList.toggle('ativa', b.dataset.v === v));
  showAviso(null);
  $('#corpo').classList.toggle('largo', v === 'calculo');
  if (VIEWS_QUE_USAM_CALCULO.has(v)) {
    $('#main').innerHTML = '<div class="cartao"><div class="dica">Calculando…</div></div>';
    try { await carregarCalculo(); } catch (e) { showAviso('erro', 'Falha ao calcular: ' + e.message); }
  }
  render();
}
document.querySelectorAll('.aba').forEach(b => b.onclick = () => setView(b.dataset.v));

$('#chkNomes').onchange = e => { state.exibirNomes = e.target.checked; render(); };

function render() {
  const render_fn = { dados: renderDados, parametros: renderParametros, calculo: renderCalculo,
    semanal: renderSemanal, diretoria: renderDiretoria, extrato: renderExtrato }[state.view];
  $('#main').innerHTML = render_fn ? render_fn() : '';
  const wire_fn = { dados: wireDados, parametros: wireParametros, calculo: wireCalculo, semanal: wireSemanal, diretoria: wireDiretoria, extrato: wireExtrato }[state.view];
  if (wire_fn) wire_fn();
}

function placeholder(titulo) {
  return `<div class="cartao"><h2>${esc(titulo)}</h2><div class="dica">Em construção — chega nas próximas fases.</div></div>`;
}
/* =============== aba: relatorio semanal =============== */
function semanasDoPeriodo() {
  const inicio = new Date(DADOS.periodo.inicio + 'T00:00:00');
  const fim = new Date(DADOS.periodo.fim + 'T00:00:00');
  const semanas = [];
  for (let idx = 0; idx < (CALC ? CALC.nSem : 0); idx++) {
    const ini = new Date(inicio.getTime() + idx * 7 * 86400000);
    const fimSem = new Date(Math.min(fim.getTime(), ini.getTime() + 6 * 86400000));
    semanas.push({ idx, rotulo: `Sem ${idx + 1}`, faixa: `${dataCurta(ini)}–${dataCurta(fimSem)}` });
  }
  return semanas;
}
function diasDecorridos() {
  const diasTotais = diasNoPeriodo(DADOS.periodo.inicio, DADOS.periodo.fim);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const inicio = new Date(DADOS.periodo.inicio + 'T00:00:00');
  const fim = new Date(DADOS.periodo.fim + 'T00:00:00');
  if (hoje < inicio) return 0;
  if (hoje > fim) return diasTotais;
  return Math.round((hoje - inicio) / 86400000) + 1;
}

function exportarCsvSemanal() {
  const yt = semanasDoPeriodo();
  const cabecalho = ['Matrícula', ...(state.exibirNomes ? ['Nome'] : []), 'Departamento', 'Especialidade',
    ...yt.map(s => `${s.rotulo} R$`), 'Ton total', 'Viagens', 'Salário base R$', 'Gratificação R$', 'Teto gratif. R$', '% Atingido', 'Total a receber R$'];
  const linhas = [cabecalho];
  for (const k of (CALC ? CALC.lista : [])) {
    linhas.push([k.mat, ...(state.exibirNomes ? [k.nome] : []), k.departamento || 'Não informado', k.espec,
      ...yt.map(s => numBR(k.semanas[String(s.idx)]?.valor || 0)), numBR(k.ton), k.viagens, numBR(k.sal), numBR(k.gratif), numBR(k.teto), numBR(k.atingPct * 100, 1) + '%', numBR(k.totalReceber)]);
  }
  const csv = linhas.map(l => l.map(v => `"${v}"`).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gratificacao_semanal_${DADOS.periodo.inicio}_a_${DADOS.periodo.fim}.csv`;
  a.click();
}

function acumuladosSemana(k, nSem) {
  const acc = [];
  let valorAcum = 0, tonAcum = 0;
  for (let idx = 0; idx < nSem; idx++) {
    const sem = k.semanas[String(idx)];
    if (sem) { valorAcum += sem.valor; tonAcum += sem.ton; }
    acc.push({ valorAcum, tonAcum });
  }
  return acc;
}

function renderSemanal() {
  if (!CALC) return placeholder('Relatório semanal');
  const f = state.filtroSemanal;
  const todasSemanas = semanasDoPeriodo();
  const semanasVisiveis = f.semana === 'TODAS' ? todasSemanas : todasSemanas.filter(s => String(s.idx) === f.semana);
  const departamentos = [...new Set(CALC.lista.map(k => k.departamento || 'Não informado'))].sort();
  const lista = CALC.lista.filter(k => k.viagens > 0 && (f.departamento === 'TODOS' || (k.departamento || 'Não informado') === f.departamento));
  const diasTotais = diasNoPeriodo(DADOS.periodo.inicio, DADOS.periodo.fim);
  const decorridos = diasDecorridos();
  const baseProjecao = decorridos > 0 ? decorridos : diasTotais;

  const linhas = lista.map(k => {
    const projecao = decorridos > 0 && decorridos < diasTotais ? k['prodR$'] / baseProjecao * diasTotais : k['prodR$'];
    const acc = acumuladosSemana(k, CALC.nSem);
    return `
      <tr>
        <td class="mono">${esc(k.mat)}</td>
        <td>${state.exibirNomes ? esc(k.nome) : `Colaborador ${esc(k.mat)}`}</td>
        <td class="tag-sem">${esc(k.departamento || 'Não informado')}</td>
        <td>${badgeEspec(k.espec)}</td>
        ${semanasVisiveis.map(s => {
          const a = acc[s.idx];
          if (!a || (a.valorAcum === 0 && a.tonAcum === 0)) return '<td class="num"><span style="color:var(--muted)">—</span></td>';
          const pct = k.teto ? a.valorAcum / k.teto * 100 : 0;
          return `<td class="num"><span style="font-weight:600${pct > 100 ? ';color:var(--ambar)' : ''}">${numBR(pct, 1)}%</span><div class="tag-sem">${numBR(a.tonAcum, 0)} t</div></td>`;
        }).join('')}
        <td class="num">${numBR(k.ton, 0)}</td>
        <td class="num" style="color:${projecao >= k.teto ? 'var(--verde)' : 'var(--ambar)'};font-weight:600">${numBR(k.teto ? projecao / k.teto * 100 : 0, 1)}%</td>
      </tr>`;
  }).join('');

  return `
    <div class="cartao">
      <div class="linha-form" style="justify-content:space-between">
        <div>
          <h2 style="margin:0">Acompanhamento semanal</h2>
          <div class="dica" style="margin:4px 0 0">Progresso acumulado de toneladas e % da gratificação atingida a cada semana do período (${brDate(DADOS.periodo.inicio)} a ${brDate(DADOS.periodo.fim)}). A projeção estende o ritmo atual até o fim do período.</div>
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
            <th class="num">Ton acum.</th><th class="num">Projeção fim (%)</th>
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
    somaTeto += k.teto || 0;
    for (const s of semanas) {
      const sem = k.semanas[String(s.idx)];
      if (sem) { s.valor += sem.valor; s.ton += sem.ton; }
    }
    porEspec[k.espec] || (porEspec[k.espec] = { ton: 0, n: 0, gratif: 0, viagens: 0 });
    const pe = porEspec[k.espec];
    pe.ton += k.ton; pe.n++; pe.gratif += k.gratif; pe.viagens += k.viagens;
    if (k.teto) {
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

function renderExtrato() {
  if (!CALC) return placeholder('Extrato colaborador');
  const pe = CALC.lista.filter(k => k.viagens > 0);
  const me = pe.find(k => k.mat === state.extratoMat) || pe[0];
  if (!me) {
    return `<div class="cartao"><h2>Extrato do colaborador</h2><div class="dica">Sem dados — importe as bases ou carregue a demonstração na aba Dados.</div></div>`;
  }
  const especCfg = (PARAMS.especialidades || []).find(e => e.chave === me.espec) || {};
  const tabelaNome = especCfg.tabela || 'canavieiro';
  const referenciaDia = km => me.espec === 'COLHEDORA' ? PARAMS.tetoColhedora.metaDia
    : me.espec === 'TRANSBORDO' ? PARAMS.tetoTransbordo.metaDia
    : tonReferencia(km, tabelaNome);
  const especLabelFull = { CAMINHAO: 'Caminhão canavieiro', 'BATE-VOLTA': 'Caminhão bate e volta', COLHEDORA: 'Colhedora de cana', TRANSBORDO: 'Trator transbordo' }[me.espec] || me.espec;
  const producaoBruta = me['prodR$'];
  const faltaTeto = Math.max(0, me.teto - me.gratif);
  const semanas = semanasDoPeriodo();
  const maxSemValor = Math.max(1, ...semanas.map(s => (me.semanas[String(s.idx)] || {}).valor || 0));
  let acumulado = 0;
  const semanasAcum = semanas.map(s => {
    const w = me.semanas[String(s.idx)];
    acumulado += w ? w.valor : 0;
    return { ...s, w, acum: acumulado };
  });
  const pctGratifDoTotal = me.totalReceber > 0 ? me.gratif / me.totalReceber * 100 : 0;
  const diasBase = DADOS.diasBase;

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
      <div class="campo">
        <label>Colaborador (matrícula)</label>
        <select id="extratoSelect" style="min-width:260px">
          ${pe.map(k => `<option value="${esc(k.mat)}" ${k.mat === me.mat ? 'selected' : ''}>${esc(k.mat)}${state.exibirNomes ? ' — ' + esc(k.nome) : ''} · ${ESPEC_LABEL[k.espec] || esc(k.espec)}</option>`).join('')}
        </select>
      </div>
      <button class="btn" id="btnImprimirExtrato">Imprimir extrato / PDF</button>
    </div>

    <div class="cartao">
      <div class="recibo-topo">
        <div>
          <div class="idc">Matrícula ${esc(me.mat)}</div>
          ${state.exibirNomes ? `<div style="font-weight:600;margin-top:2px">${esc(me.nome)}</div>` : ''}
          <div class="tag-sem" style="margin-top:4px">${esc(especLabelFull)}${me.funcao ? ' · ' + esc(me.funcao) : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:'Barlow Condensed';font-weight:700;font-size:20px;color:var(--verde-esc);text-transform:uppercase;letter-spacing:.6px">Extrato de gratificação</div>
          <div class="tag-sem">Período ${brDate(DADOS.periodo.inicio)} a ${brDate(DADOS.periodo.fim)} · ${me.dias} de ${diasBase} dias trabalhados (base prorata)</div>
        </div>
      </div>
      <div class="comp">
        <div class="bloco">
          <div class="r">Gratificação de produção</div>
          <div class="v">${brl(me.gratif)}</div>
          <div class="d">${numBR(me.ton, 1)} t em ${me.viagens} pesagens${me.kmMed ? ` · raio méd. ${numBR(me.kmMed, 0)} km` : ''}</div>
          <div class="d">${numBR(producaoBruta)} produzido${me.dias < diasBase ? ` × ${me.dias}/${diasBase} dias` : ''}${PARAMS.aplicarTeto && producaoBruta > me.teto ? ' · travado no teto' : ''}</div>
        </div>
        <div class="bloco">
          <div class="r">Teto da gratificação — ${brl(me.teto)}</div>
          <div class="v" style="color:${me.atingPct >= 1 ? 'var(--ambar)' : 'var(--verde-esc)'}">${numBR(me.atingPct * 100, 1)}%</div>
          <div class="barra" style="height:10px;margin:4px 0 6px"><i class="${me.atingPct > 1 ? 'acima' : ''}" style="width:${Math.min(100, me.atingPct * 100)}%"></i></div>
          ${me.atingPct >= 1
            ? `<div class="d" style="color:var(--ambar);font-weight:600">Passou do teto em ${brl(me.gratif - me.teto)}</div>`
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
                  <div class="barra" style="width:80px"><i class="${s.acum > me.teto ? 'acima' : ''}" style="width:${Math.min(100, (me.teto ? s.acum / me.teto : 0) * 100)}%"></i></div>
                  <span class="mono" style="font-size:11.5px">${numBR((me.teto ? s.acum / me.teto : 0) * 100, 1)}%</span>
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
    ${modal}`;
}
function wireExtrato() {
  const select = $('#extratoSelect');
  if (select) select.onchange = e => { state.extratoMat = e.target.value; state.extratoSemanaAberta = null; render(); };
  const btnImprimir = $('#btnImprimirExtrato');
  if (btnImprimir) btnImprimir.onclick = () => window.print();
  $('#main').querySelectorAll('[data-semana-idx]').forEach(tr => {
    tr.onclick = () => { state.extratoSemanaAberta = +tr.dataset.semanaIdx; render(); };
  });
  const ov = $('#extratoModalOv');
  if (ov) {
    ov.onclick = () => { state.extratoSemanaAberta = null; render(); };
    $('#extratoModalBox').onclick = e => e.stopPropagation();
    $('#extratoModalFechar').onclick = () => { state.extratoSemanaAberta = null; render(); };
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

function calculoFiltrado() {
  const f = state.filtroCalculo;
  const lista = CALC ? CALC.lista : [];
  return lista.filter(k =>
    (!f.apenasComProducao || k.viagens > 0) &&
    (f.especialidade === 'TODOS' || k.espec === f.especialidade) &&
    (f.departamento === 'TODOS' || (k.departamento || 'Não informado') === f.departamento) &&
    (!f.busca || norm(k.nome).includes(norm(f.busca)) || String(k.mat).includes(f.busca))
  );
}

function linhaCalculo(k) {
  const f = state.filtroCalculo;
  const frotasEntries = Object.entries(k.frotas || {}).sort((a, b) => b[1].ton - a[1].ton);
  const aberto = f.detalheAberto === k.mat;
  const admissao = k.admissao ? brDate(k.admissao) : '—';
  const linhaPrincipal = `
    <tr class="linha-calc">
      <td class="mono">${esc(k.mat)}</td>
      <td>${state.exibirNomes ? esc(k.nome) : `Colaborador ${esc(k.mat)}`}<div class="tag-sem">${esc(k.funcao || '')}</div></td>
      <td class="tag-sem">${esc(k.departamento || 'Não informado')}</td>
      <td class="num tag-sem">${admissao}</td>
      <td>${badgeEspec(k.espec)}</td>
      <td class="num">${k.diasTrabalhados}</td>
      <td class="num">${k.viagens}</td>
      <td class="num">${numBR(k.ton, 1)}</td>
      <td class="num">${k.kmMed ? numBR(k.kmMed, 0) : '—'}</td>
      <td style="white-space:nowrap">${frotasEntries.length
        ? `<button type="button" class="btn peq sec" data-detalhe="${esc(k.mat)}">🔍 ${frotasEntries.length} frota${frotasEntries.length > 1 ? 's' : ''} ${aberto ? '▴' : '▾'}</button>`
        : '—'}</td>
      <td class="num">${numBR(k.sal)}</td>
      <td class="num" style="font-weight:600;color:var(--verde-esc)">${numBR(k.gratif)}</td>
      <td class="num">${numBR(k.teto, 0)}</td>
      <td><div style="display:flex;align-items:center;gap:6px">
        <div class="barra" style="width:80px"><i class="${k.atingPct > 1 ? 'acima' : ''}" style="width:${Math.min(100, k.atingPct * 100)}%"></i></div>
        <span class="mono" style="font-size:11.5px;font-weight:${k.atingPct > 1 ? 700 : 400}${k.atingPct > 1 ? ';color:var(--ambar)' : ''}">${numBR(k.atingPct * 100, 1)}%</span>
        ${k.ajustePct ? `<span class="tag-sem" style="color:var(--azul)" title="Ajuste manual: +${numBR(k.ajustePct, 1)}% — ${esc(k.ajusteObs || '')}">+${numBR(k.ajustePct, 1)}% ajuste</span>` : ''}
      </div></td>
      <td class="num" style="font-weight:600">${numBR(k.totalReceber)}</td>
      <td class="col-acoes" style="white-space:nowrap">
        <button type="button" class="btn peq sec" data-extrato="${esc(k.mat)}" title="Abrir extrato do colaborador">📄 Extrato</button>
        <button type="button" class="btn peq sec" data-ajuste="${esc(k.mat)}" title="Ajustar percentual manualmente">⚙️ Ajuste</button>
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
    <tr class="linha-frotas"><td colspan="16"><div class="frotas-box">${corpoDetalhe}</div></td></tr>`;
}

function tabelaCalculo(lista) {
  if (!lista.length) {
    return `<div class="scroll-x"><table><tbody><tr><td style="text-align:center;padding:24px;color:var(--muted)">Sem dados — importe as bases ou carregue a demonstração na aba Dados.</td></tr></tbody></table></div>`;
  }
  return `
    <div class="scroll-x tabela-calc">
      <table>
        <thead><tr>
          <th>Mat.</th><th>Colaborador</th><th>Departamento</th><th>Admissão</th><th>Espec.</th>
          <th class="num">Dias</th><th class="num">Viagens</th><th class="num">Ton</th><th class="num">Km méd.</th>
          <th>Frotas / disponib.</th><th class="num">Salário base</th><th class="num">Gratificação (R$)</th>
          <th class="num">Teto (R$)</th><th>% Atingido</th><th class="num">Total (R$)</th><th class="col-acoes">Ações</th>
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
  return `
    <div class="modal-ov no-print" id="ajusteModalOv">
      <div class="modal-box" id="ajusteModalBox">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <h3>Ajuste manual — ${esc(k.mat)}</h3>
          <button class="modal-fecha" id="ajusteModalFechar">×</button>
        </div>
        <div class="dica">Soma pontos percentuais ao % atingido deste colaborador (ex.: produção real não capturada pelo sistema, como viagens particulares). O total nunca ultrapassa 100% do teto por conta deste ajuste. É obrigatório justificar — fica registrado para auditoria e aparece no extrato do colaborador.</div>
        <div class="campo" style="margin-top:10px;max-width:160px">
          <label>Percentual a somar (%)</label>
          <input type="number" step="0.1" id="ajustePctInput" value="${esc(k.ajustePct ?? '')}" placeholder="ex: 15">
        </div>
        <div class="campo" style="margin-top:10px">
          <label>Observação (obrigatória)</label>
          <textarea id="ajusteObsInput" rows="3" style="width:100%;font-family:'Inter';font-size:13px;padding:8px;border:1px solid var(--linha);border-radius:5px;box-sizing:border-box" placeholder="Explique o motivo do ajuste…">${esc(k.ajusteObs || '')}</textarea>
        </div>
        <div class="linha-form" style="margin-top:14px;justify-content:space-between">
          <button class="btn sec" id="ajusteRemover" style="color:var(--vermelho);border-color:var(--vermelho)" ${k.ajustePct ? '' : 'disabled'}>Remover ajuste</button>
          <div style="display:flex;gap:8px">
            <button class="btn sec" id="ajusteCancelar">Cancelar</button>
            <button class="btn" id="ajusteSalvar">Salvar ajuste</button>
          </div>
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
    acc.n++; acc.ton += k.ton; acc.viagens += k.viagens; acc.gratif += k.gratif; acc.sal += k.sal; acc.totalReceber += k.totalReceber;
    return acc;
  }, { n: 0, ton: 0, viagens: 0, gratif: 0, sal: 0, totalReceber: 0 });
  const diasBase = DADOS.diasBase;
  const especCaminhao = (PARAMS.especialidades || []).find(e => e.chave === 'CAMINHAO') || {};
  const grupos = [
    { ch: ['CAMINHAO', 'BATE-VOLTA'], tit: 'Motoristas — Caminhão canavieiro',
      crit: `cada viagem vale peso (t) × R$/t da faixa de km da viagem · teto R$ ${numBR(especCaminhao.valorProd || 0, 0)} · prorata ${diasBase} dias-base` },
    { ch: ['COLHEDORA'], tit: 'Operadores — Colhedora',
      crit: `meta ${numBR(PARAMS.tetoColhedora.metaDia, 0)} t/dia × ${diasBase} dias-base = ${numBR(PARAMS.tetoColhedora.metaDia * diasBase, 0)} t · gratificação = % da meta × R$ ${numBR(PARAMS.tetoColhedora.valor, 0)}` },
    { ch: ['TRANSBORDO'], tit: 'Operadores — Transbordo',
      crit: `meta ${numBR(PARAMS.tetoTransbordo.metaDia, 0)} t/dia × ${diasBase} dias-base = ${numBR(PARAMS.tetoTransbordo.metaDia * diasBase, 0)} t · gratificação = % da meta × R$ ${numBR(PARAMS.tetoTransbordo.valor, 0)}` },
  ];
  const secoes = grupos.map(g => {
    const itens = filtrado.filter(k => g.ch.includes(k.espec));
    if (!itens.length) return '';
    const tot = itens.reduce((a, k) => (a.n++, a.ton += k.ton, a.g += k.gratif, a), { n: 0, ton: 0, g: 0 });
    return `
      <div class="cartao">
        <div class="sec-head">
          <div><h2 style="margin:0">${esc(g.tit)}</h2><div class="dica" style="margin:2px 0 0">Critério: ${esc(g.crit)}</div></div>
          <div class="sec-tot mono">${tot.n} colab. · ${numBR(tot.ton, 0)} t · R$ ${numBR(tot.g, 0)}</div>
        </div>
        ${tabelaCalculo(itens)}
      </div>`;
  }).filter(Boolean).join('');

  return `
    <div class="kpis">
      <div class="kpi"><div class="rot">Colaboradores</div><div class="val">${resumo.n}</div><div class="det">${f.especialidade === 'TODOS' ? 'todas as especialidades' : ESPEC_LABEL[f.especialidade] || f.especialidade}</div></div>
      <div class="kpi"><div class="rot">Toneladas no período</div><div class="val">${numBR(resumo.ton, 0)}</div><div class="det">${resumo.viagens.toLocaleString('pt-BR')} viagens</div></div>
      <div class="kpi"><div class="rot">Gratificação (R$)</div><div class="val">${numBR(resumo.gratif, 0)}</div><div class="det">prorata base ${diasBase} dias</div></div>
      <div class="kpi"><div class="rot">Folha salário base (R$)</div><div class="val">${numBR(resumo.sal, 0)}</div><div class="det">soma dos ${resumo.n} colaboradores</div></div>
      <div class="kpi"><div class="rot">Salário + gratificação</div><div class="val">${numBR(resumo.totalReceber, 0)}</div><div class="det">sem HE e DSR</div></div>
    </div>
    <div class="cartao">
      <div class="linha-form" style="justify-content:space-between">
        <h2 style="margin:0">Cálculo por colaborador</h2>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <input id="calcBusca" placeholder="Buscar nome ou matrícula…" value="${esc(f.busca)}" style="width:220px">
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
          <button class="btn no-print" id="btnExportarCalculoPdf">Exportar PDF</button>
        </div>
      </div>
    </div>
    ${secoes || '<div class="cartao"><div style="text-align:center;padding:24px;color:var(--muted)">Sem dados — importe as bases ou carregue a demonstração na aba Dados.</div></div>'}
    ${renderAjusteModal()}`;
}
function wireCalculo() {
  const f = state.filtroCalculo;
  $('#calcBusca').oninput = e => { f.busca = e.target.value; renderPreservandoFoco(); };
  $('#calcSoProducao').onchange = e => { f.apenasComProducao = e.target.checked; render(); };
  $('#calcEspec').onchange = e => { f.especialidade = e.target.value; render(); };
  $('#calcDepto').onchange = e => { f.departamento = e.target.value; render(); };
  $('#main').querySelectorAll('[data-detalhe]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const mat = btn.dataset.detalhe;
      f.detalheAberto = f.detalheAberto === mat ? null : mat;
      render();
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
      render();
    };
  });
  const btnPdf = $('#btnExportarCalculoPdf');
  if (btnPdf) btnPdf.onclick = () => window.print();

  const ov = $('#ajusteModalOv');
  if (ov) {
    const fechar = () => { state.ajusteModalMat = null; render(); };
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
        await api(`/ajuste/${encodeURIComponent(mat)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct, obs }) });
        state.ajusteModalMat = null;
        await carregarCalculo();
        render();
        showToast('ok', 'Ajuste salvo.');
      } catch (e) { showToast('erro', e.message); }
      finally { setBtnLoading(btn, false); }
    };
    $('#ajusteRemover').onclick = async () => {
      const mat = state.ajusteModalMat;
      const btn = $('#ajusteRemover');
      setBtnLoading(btn, true);
      try {
        await api(`/ajuste/${encodeURIComponent(mat)}`, { method: 'DELETE' });
        state.ajusteModalMat = null;
        await carregarCalculo();
        render();
        showToast('ok', 'Ajuste removido.');
      } catch (e) { showToast('erro', e.message); }
      finally { setBtnLoading(btn, false); }
    };
  }
}

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
Promise.all([carregarDados(), carregarParametros()]).then(() => setView('dados'));

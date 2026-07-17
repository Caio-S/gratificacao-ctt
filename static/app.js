'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brl = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const numBR = (n, casas = 2) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const brDate = iso => iso ? iso.split('-').reverse().join('/') : '—';

/* =============== estado =============== */
const state = {
  view: 'dados',
  exibirNomes: false,
};

/* dados carregados do backend (funcionarios/pesagens/frotas/periodo) */
let DADOS = { funcionarios: [], pesagens: [], frotas: [], periodo: { inicio: null, fim: null }, diasBase: 25 };
let PARAMS = null;

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
  const wire_fn = { dados: wireDados, parametros: wireParametros }[state.view];
  if (wire_fn) wire_fn();
}

function placeholder(titulo) {
  return `<div class="cartao"><h2>${esc(titulo)}</h2><div class="dica">Em construção — chega nas próximas fases.</div></div>`;
}
function renderCalculo() { return placeholder('Cálculo'); }
function renderSemanal() { return placeholder('Relatório semanal'); }
function renderDiretoria() { return placeholder('Painel diretoria'); }
function renderExtrato() { return placeholder('Extrato colaborador'); }

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

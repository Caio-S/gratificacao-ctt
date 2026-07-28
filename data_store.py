"""Camada de acesso a dados. Persiste em Postgres (Supabase) como pares
chave/valor JSONB - guarda a mesma estrutura que antes vivia num dicionario em
memoria, so que agora sobrevive a redeploys e reinicios do servidor. Cada
funcao daqui mantém a mesma assinatura de antes, entao rotas (app.py) e
front-end não precisam mudar nada."""

import os
from datetime import date

import psycopg2
import psycopg2.extras
import psycopg2.pool
from werkzeug.security import check_password_hash, generate_password_hash

import calculo_defaults

PAPEIS = ("usuario", "coordenador", "gerente", "diretoria")

_DEFAULT_PERIODO = {"inicio": "2026-06-16", "fim": "2026-07-15"}  # mesmo padrao do artefato original
_DEFAULT_DIAS_BASE = 25

_pool = None


def _obter_pool():
    """Pool de conexoes reaproveitadas - evita repetir o handshake TCP/TLS com
    o Supabase a cada leitura/escrita (cada uma custava vários segundos)."""
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.SimpleConnectionPool(1, 5, os.environ["DATABASE_URL"])
    return _pool


def _get(chave, padrao):
    pool = _obter_pool()
    conn = pool.getconn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT value FROM ctt_app_state WHERE key = %s", (chave,))
            row = cur.fetchone()
            return row[0] if row else padrao
    finally:
        pool.putconn(conn)


def _set(chave, valor):
    pool = _obter_pool()
    conn = pool.getconn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO ctt_app_state (key, value, updated_at) VALUES (%s, %s, now())
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""",
                (chave, psycopg2.extras.Json(valor)),
            )
    finally:
        pool.putconn(conn)


def _data_para_texto(d):
    return d.isoformat() if isinstance(d, date) else d


def _texto_para_data(s):
    return date.fromisoformat(s) if isinstance(s, str) else s


def _get_many(chaves_com_padroes):
    """Busca varias chaves numa unica ida ao banco (chaves_com_padroes e um
    dict {chave: valor_padrao}) - evita varias idas sequenciais nas rotas que
    precisam de mais de um valor."""
    pool = _obter_pool()
    conn = pool.getconn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT key, value FROM ctt_app_state WHERE key = ANY(%s)", (list(chaves_com_padroes),))
            encontrados = dict(cur.fetchall())
        return {k: encontrados[k] if k in encontrados else padrao for k, padrao in chaves_com_padroes.items()}
    finally:
        pool.putconn(conn)


def get_atualizados_em(chaves):
    """updated_at (ISO) de cada chave informada - usado pra mostrar 'atualizado
    ha X' na aba Dados pros dados que vem ao vivo do MariaDB."""
    pool = _obter_pool()
    conn = pool.getconn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT key, updated_at FROM ctt_app_state WHERE key = ANY(%s)", (list(chaves),))
            encontrados = dict(cur.fetchall())
        return {k: (encontrados[k].isoformat() if encontrados.get(k) else None) for k in chaves}
    finally:
        pool.putconn(conn)


def get_dados_bundle():
    """Tudo que a rota /api/dados precisa, numa unica ida ao banco."""
    valores = _get_many({
        "funcionarios": [], "pesagens": [], "frotas": [], "jornada": {},
        "periodo": _DEFAULT_PERIODO, "dias_base": _DEFAULT_DIAS_BASE,
    })
    funcionarios = valores["funcionarios"]
    for f in funcionarios:
        f["admissao"] = _texto_para_data(f.get("admissao"))
    pesagens = valores["pesagens"]
    for p in pesagens:
        p["data"] = _texto_para_data(p.get("data"))
    jornada = valores["jornada"]
    porMat = jornada.get("porMat", jornada)  # compat com o formato antigo {mat: {...}}
    atualizados = get_atualizados_em(["jornada", "funcionarios"])
    return {
        "funcionarios": funcionarios,
        "pesagens": pesagens,
        "frotas": valores["frotas"],
        "periodo": valores["periodo"],
        "dias_base": valores["dias_base"],
        "funcionarios_atualizado_em": atualizados.get("funcionarios"),
        "jornada_resumo": {
            "matriculas": len(porMat),
            "registros": sum(len(v.get("faltas", [])) for v in porMat.values()),
            "atualizadoEm": atualizados.get("jornada"),
        },
    }


def get_calculo_inputs():
    """Tudo que a rota /api/calculo precisa, numa unica ida ao banco."""
    valores = _get_many({
        "funcionarios": [], "pesagens": [], "dias_base": _DEFAULT_DIAS_BASE,
        "parametros": None, "ajustes": {}, "periodo": _DEFAULT_PERIODO, "jornada": {},
    })
    funcionarios = valores["funcionarios"]
    for f in funcionarios:
        f["admissao"] = _texto_para_data(f.get("admissao"))
    pesagens = valores["pesagens"]
    for p in pesagens:
        p["data"] = _texto_para_data(p.get("data"))
    parametros = valores["parametros"]
    if parametros is None:
        parametros = calculo_defaults.parametros_padrao()
        _set("parametros", parametros)
    return {
        "funcionarios": funcionarios,
        "pesagens": pesagens,
        "dias_base": valores["dias_base"],
        "parametros": parametros,
        "ajustes": valores["ajustes"],
        "periodo": valores["periodo"],
        "jornada": valores["jornada"],
    }


def get_funcionarios():
    lista = _get("funcionarios", [])
    for f in lista:
        f["admissao"] = _texto_para_data(f.get("admissao"))
    return lista


def set_funcionarios(lista):
    salvar = [dict(f, admissao=_data_para_texto(f.get("admissao"))) for f in lista]
    _set("funcionarios", salvar)


def get_pesagens():
    lista = _get("pesagens", [])
    for p in lista:
        p["data"] = _texto_para_data(p.get("data"))
    return lista


def set_pesagens(lista):
    salvar = [dict(p, data=_data_para_texto(p.get("data"))) for p in lista]
    _set("pesagens", salvar)


def get_frotas():
    return _get("frotas", [])


def set_frotas(lista):
    _set("frotas", lista)


def get_jornada():
    return _get("jornada", {})


def set_jornada(mapa):
    _set("jornada", mapa)


def get_jornada_import_status():
    return _get("jornada_import_status", {"status": "ocioso"})


def set_jornada_import_status(status):
    _set("jornada_import_status", status)


def get_parametros():
    params = _get("parametros", None)
    if params is None:
        params = calculo_defaults.parametros_padrao()
        _set("parametros", params)
    return params


def set_parametros(params):
    _set("parametros", params)


def get_periodo():
    return _get("periodo", _DEFAULT_PERIODO)


def set_periodo(inicio, fim):
    _set("periodo", {"inicio": inicio, "fim": fim})


def get_dias_base():
    return _get("dias_base", _DEFAULT_DIAS_BASE)


def set_dias_base(dias):
    _set("dias_base", dias)


def get_ajustes():
    return _get("ajustes", {})


def set_ajuste(mat, pct, obs):
    ajustes = get_ajustes()
    ajustes[str(mat)] = {"pct": pct, "obs": obs}
    _set("ajustes", ajustes)


def remover_ajuste(mat):
    ajustes = get_ajustes()
    ajustes.pop(str(mat), None)
    _set("ajustes", ajustes)


def _executar(sql, params=(), fetch=None):
    """fetch: None (sem retorno), 'one' ou 'all' - para as tabelas relacionais
    (usuarios, ajustes_pendentes), diferente do esquema chave/valor acima."""
    pool = _obter_pool()
    conn = pool.getconn()
    try:
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            if fetch == "one":
                row = cur.fetchone()
                return dict(row) if row else None
            if fetch == "all":
                return [dict(r) for r in cur.fetchall()]
    finally:
        pool.putconn(conn)


# ---------- usuarios ----------

def criar_usuario(username, senha, papel, nome=""):
    return _executar(
        """INSERT INTO ctt_usuarios (username, senha_hash, papel, nome)
           VALUES (%s, %s, %s, %s) RETURNING id, username, papel, nome, ativo, criado_em""",
        (username.strip().lower(), generate_password_hash(senha), papel, nome),
        fetch="one",
    )


def listar_usuarios():
    return _executar(
        "SELECT id, username, papel, nome, ativo, criado_em FROM ctt_usuarios ORDER BY criado_em", fetch="all"
    )


def buscar_usuario_por_username(username):
    return _executar("SELECT * FROM ctt_usuarios WHERE username = %s", (username.strip().lower(),), fetch="one")


def autenticar(username, senha):
    usuario = buscar_usuario_por_username(username)
    if not usuario or not usuario["ativo"]:
        return None
    if not check_password_hash(usuario["senha_hash"], senha):
        return None
    return usuario


def atualizar_usuario(user_id, papel=None, nome=None, ativo=None, senha=None):
    campos, valores = [], []
    if papel is not None:
        campos.append("papel = %s"); valores.append(papel)
    if nome is not None:
        campos.append("nome = %s"); valores.append(nome)
    if ativo is not None:
        campos.append("ativo = %s"); valores.append(ativo)
    if senha:
        campos.append("senha_hash = %s"); valores.append(generate_password_hash(senha))
    if not campos:
        return
    valores.append(user_id)
    _executar(f"UPDATE ctt_usuarios SET {', '.join(campos)} WHERE id = %s", valores)


def remover_usuario(user_id):
    _executar("DELETE FROM ctt_usuarios WHERE id = %s", (user_id,))


def existe_algum_usuario():
    row = _executar("SELECT id FROM ctt_usuarios LIMIT 1", fetch="one")
    return row is not None


# ---------- ajustes pendentes (fluxo de aprovacao) ----------

def criar_ajuste_pendente(mat, pct, obs, criado_por):
    return _executar(
        """INSERT INTO ctt_ajustes_pendentes (mat, pct, obs, criado_por)
           VALUES (%s, %s, %s, %s) RETURNING *""",
        (mat, pct, obs, criado_por),
        fetch="one",
    )


def listar_ajustes_pendentes():
    return _executar(
        "SELECT * FROM ctt_ajustes_pendentes WHERE status = 'pendente' ORDER BY criado_em", fetch="all"
    )


def listar_ajustes_historico(limite=100):
    return _executar(
        "SELECT * FROM ctt_ajustes_pendentes WHERE status != 'pendente' ORDER BY criado_em DESC LIMIT %s",
        (limite,),
        fetch="all",
    )


def aprovar_ajustes(ids, papel, usuario):
    """papel: 'gerente' ou 'diretoria'. Marca a aprovacao desse papel pra cada
    id da lista; quando os dois papeis ja tiverem aprovado, aplica o ajuste de
    verdade (grava em 'ajustes', que calculo.py ja consome) e fecha como
    aprovado. Devolve a lista de matriculas que acabaram de ser aplicadas."""
    coluna_flag = "aprovado_gerente" if papel == "gerente" else "aprovado_diretoria"
    coluna_por = "aprovado_gerente_por" if papel == "gerente" else "aprovado_diretoria_por"
    coluna_em = "aprovado_gerente_em" if papel == "gerente" else "aprovado_diretoria_em"
    aplicados = []
    for ajuste_id in ids:
        _executar(
            f"""UPDATE ctt_ajustes_pendentes SET {coluna_flag} = true, {coluna_por} = %s, {coluna_em} = now()
                WHERE id = %s AND status = 'pendente'""",
            (usuario, ajuste_id),
        )
        row = _executar("SELECT * FROM ctt_ajustes_pendentes WHERE id = %s", (ajuste_id,), fetch="one")
        if row and row["aprovado_gerente"] and row["aprovado_diretoria"] and row["status"] == "pendente":
            set_ajuste(row["mat"], float(row["pct"]), row["obs"])
            _executar("UPDATE ctt_ajustes_pendentes SET status = 'aprovado' WHERE id = %s", (ajuste_id,))
            aplicados.append(row["mat"])
    return aplicados


def rejeitar_ajuste(ajuste_id, usuario, motivo):
    _executar(
        """UPDATE ctt_ajustes_pendentes SET status = 'rejeitado', rejeitado_por = %s,
           rejeitado_em = now(), motivo_rejeicao = %s WHERE id = %s AND status = 'pendente'""",
        (usuario, motivo, ajuste_id),
    )


# ---------- aprovacao de gratificacao (checklist de revisao por periodo) ----------
# Diferente de ctt_ajustes_pendentes (que é uma PROPOSTA de mudança de %), isto
# aqui é só um sinal de "Gerente/Diretoria revisou e confere com esse valor" -
# não trava nem recalcula nada, e cada papel pode desfazer o proprio voto a
# qualquer momento. Escopado por periodo (inicio/fim), entao um periodo novo
# comeca sempre com nada aprovado.

def listar_aprovacoes_gratificacao(periodo_inicio, periodo_fim):
    linhas = _executar(
        "SELECT * FROM ctt_gratificacao_aprovacoes WHERE periodo_inicio = %s AND periodo_fim = %s",
        (periodo_inicio, periodo_fim),
        fetch="all",
    )
    return {r["mat"]: r for r in linhas}


def _colunas_aprovacao(papel):
    sufixo = "gerente" if papel == "gerente" else "diretoria"
    return f"aprovado_{sufixo}", f"aprovado_{sufixo}_por", f"aprovado_{sufixo}_em"


def _mats_unicas(mats):
    """Sem repetidas: o ON CONFLICT DO UPDATE quebra se a mesma linha aparecer
    duas vezes no mesmo comando."""
    return list(dict.fromkeys(str(m) for m in mats if str(m).strip()))


def aprovar_gratificacoes(mats, papel, usuario, periodo_inicio, periodo_fim):
    """Grava o lote inteiro numa UNICA ida ao banco. Antes era um INSERT por
    matricula: com algumas centenas de colaboradores selecionados isso passava
    de um minuto e estourava o timeout do proxy (o usuario via erro 500)."""
    mats = _mats_unicas(mats)
    if not mats:
        return
    coluna_flag, coluna_por, coluna_em = _colunas_aprovacao(papel)
    sql = f"""INSERT INTO ctt_gratificacao_aprovacoes (mat, periodo_inicio, periodo_fim, {coluna_flag}, {coluna_por}, {coluna_em})
              VALUES %s
              ON CONFLICT (mat, periodo_inicio, periodo_fim)
              DO UPDATE SET {coluna_flag} = true, {coluna_por} = EXCLUDED.{coluna_por}, {coluna_em} = now()"""
    linhas = [(mat, periodo_inicio, periodo_fim, True, usuario) for mat in mats]
    pool = _obter_pool()
    conn = pool.getconn()
    try:
        with conn, conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, sql, linhas, template="(%s, %s, %s, %s, %s, now())", page_size=1000)
    finally:
        pool.putconn(conn)
    return len(mats)


def desfazer_aprovacao_gratificacao(mats, papel, periodo_inicio, periodo_fim):
    """Idem: um UPDATE so pra todas as matriculas do lote."""
    mats = _mats_unicas(mats)
    if not mats:
        return
    coluna_flag, coluna_por, coluna_em = _colunas_aprovacao(papel)
    _executar(
        f"""UPDATE ctt_gratificacao_aprovacoes SET {coluna_flag} = false, {coluna_por} = NULL, {coluna_em} = NULL
            WHERE mat IN %s AND periodo_inicio = %s AND periodo_fim = %s""",
        (tuple(mats), periodo_inicio, periodo_fim),
    )
    return len(mats)


# ---------- fechamento de periodo ----------
# Cada periodo fechado vira um snapshot proprio (chave "fechamento:inicio_fim")
# com a gratificacao final de cada colaborador. Um indice separado guarda so os
# totais, pra listar os meses sem carregar todas as linhas de todos eles.

def _chave_fechamento(inicio, fim):
    return f"fechamento:{inicio}_{fim}"


def get_fechamentos_indice():
    return _get("fechamentos_indice", [])


def get_fechamento(inicio, fim):
    return _get(_chave_fechamento(inicio, fim), None)


def salvar_fechamento(registro):
    periodo = registro["periodo"]
    _set(_chave_fechamento(periodo["inicio"], periodo["fim"]), registro)
    resumo = {c: registro[c] for c in ("periodo", "diasBase", "fechadoEm", "fechadoPor", "resumo")}
    # refechar o mesmo periodo substitui a entrada em vez de duplicar
    indice = [
        f for f in get_fechamentos_indice()
        if not (f["periodo"]["inicio"] == periodo["inicio"] and f["periodo"]["fim"] == periodo["fim"])
    ]
    indice.append(resumo)
    indice.sort(key=lambda f: f["periodo"]["inicio"], reverse=True)
    _set("fechamentos_indice", indice)


def limpar_ajustes():
    """Os ajustes manuais sao guardados so por matricula, entao precisam ser
    zerados ao virar o periodo - senao um ajuste justificado por um fato do mes
    passado continuaria valendo no mes novo."""
    _set("ajustes", {})


def descartar_ajustes_pendentes():
    _executar("UPDATE ctt_ajustes_pendentes SET status = 'descartado' WHERE status = 'pendente'")


BASES_LIMPAVEIS = {"funcionarios": [], "pesagens": [], "frotas": [], "jornada": {}}


def limpar_base(base):
    """Zera so uma das bases importadas (ex.: pesagens), pra poder subir um
    arquivo novo sem derrubar funcionarios/frotas/jornada junto."""
    _set(base, BASES_LIMPAVEIS[base])
    if base == "jornada":
        _set("jornada_import_status", {"status": "ocioso"})


def limpar_tudo():
    for base in BASES_LIMPAVEIS:
        limpar_base(base)

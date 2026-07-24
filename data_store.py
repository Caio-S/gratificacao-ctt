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

import calculo_defaults

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


def get_dados_bundle():
    """Tudo que a rota /api/dados precisa, numa unica ida ao banco."""
    valores = _get_many({
        "funcionarios": [], "pesagens": [], "frotas": [],
        "periodo": _DEFAULT_PERIODO, "dias_base": _DEFAULT_DIAS_BASE,
    })
    funcionarios = valores["funcionarios"]
    for f in funcionarios:
        f["admissao"] = _texto_para_data(f.get("admissao"))
    pesagens = valores["pesagens"]
    for p in pesagens:
        p["data"] = _texto_para_data(p.get("data"))
    return {
        "funcionarios": funcionarios,
        "pesagens": pesagens,
        "frotas": valores["frotas"],
        "periodo": valores["periodo"],
        "dias_base": valores["dias_base"],
    }


def get_calculo_inputs():
    """Tudo que a rota /api/calculo precisa, numa unica ida ao banco."""
    valores = _get_many({
        "funcionarios": [], "pesagens": [], "dias_base": _DEFAULT_DIAS_BASE,
        "parametros": None, "ajustes": {}, "periodo": _DEFAULT_PERIODO,
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


def limpar_tudo():
    _set("funcionarios", [])
    _set("pesagens", [])
    _set("frotas", [])

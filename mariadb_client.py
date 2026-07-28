"""Conexao com o MariaDB da CRV Industrial (syscustoWeb) - banco de producao
da empresa, SOMENTE LEITURA. Usado so pra buscar a escala/jornada direto do
sistema (vw_escala_jornada_funcionario) em vez de depender de planilha
exportada e importada manualmente. Nunca fazer INSERT/UPDATE/DELETE aqui."""

import os

import pymysql

_CODIGO_EMPRESA_CRV_MG = 7


def _conectar():
    return pymysql.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", 3306)),
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        database=os.environ["DB_NAME"],
        charset="utf8mb4",
        connect_timeout=15,
        read_timeout=120,
    )


def buscar_jornada(periodo_inicio, periodo_fim):
    """Devolve (colunas, linhas) da vw_escala_jornada_funcionario pro
    periodo informado (strings 'aaaa-mm-dd') - o periodo fica sempre em
    aberto, nunca fixo, pra acompanhar o periodo de apuracao configurado
    na aba Dados."""
    conn = _conectar()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT a.* FROM vw_escala_jornada_funcionario a "
                "WHERE a.codigo_empresa = %s AND a.`data` BETWEEN %s AND %s",
                (_CODIGO_EMPRESA_CRV_MG, periodo_inicio, periodo_fim),
            )
            colunas = [d[0] for d in cur.description]
            linhas = cur.fetchall()
        return colunas, linhas
    finally:
        conn.close()

"""Funcoes utilitarias portadas fielmente do artefato original (Gratificacao CTT).
Nomes em portugues aqui; no artefato React minificado eram nomes de 1-2 letras
(Rt, Kt, go, yc, P1, L1, Lr, De, Dk, etc.) - mantive um comentario com o nome
original em cada uma pra facilitar conferencia com o codigo-fonte."""

import re
import unicodedata
from datetime import date, datetime, timedelta

VALORES_VAZIOS = {"", "\\N", "NULL", "NIL", "-", "0"}


def normalizar(valor):
    """Rt: string sem acento, maiuscula, sem espaco nas pontas."""
    s = "" if valor is None else str(valor)
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.upper().strip()


def valor_valido(valor):
    """yc: verdadeiro se o valor NAO é um dos marcadores de vazio (branco, \\N, NULL, NIL, -, 0)."""
    return normalizar(valor) not in VALORES_VAZIOS


def parse_numero(valor):
    """go: numero no formato BR (1.234,56) ou já numerico. 0 se nao der pra converter."""
    if valor is None or valor == "":
        return 0
    if isinstance(valor, (int, float)):
        return float(valor)
    texto = str(valor).replace(".", "").replace(",", ".")
    try:
        return float(texto)
    except ValueError:
        try:
            return float(str(valor))
        except ValueError:
            return 0


_RE_DATA_BR = re.compile(r"^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})")
_RE_DATA_ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})")


def parse_data(valor):
    """P1: aceita datetime/date, numero serial do Excel, dd/mm/aaaa ou aaaa-mm-dd."""
    if valor is None or valor == "":
        return None
    if isinstance(valor, datetime):
        return valor.date()
    if isinstance(valor, date):
        return valor
    if isinstance(valor, (int, float)):
        try:
            return (datetime(1970, 1, 1) + timedelta(days=valor - 25569)).date()
        except (OverflowError, ValueError):
            return None
    texto = str(valor).strip()
    m = _RE_DATA_BR.match(texto)
    if m:
        dia, mes, ano = int(m.group(1)), int(m.group(2)), m.group(3)
        ano = 2000 + int(ano) if len(ano) == 2 else int(ano)
        try:
            return date(ano, mes, dia)
        except ValueError:
            return None
    m = _RE_DATA_ISO.match(texto)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


def data_iso(d):
    """L1: date -> 'aaaa-mm-dd'."""
    return d.strftime("%Y-%m-%d") if d else ""


def data_curta(d):
    """Lr: date -> 'dd/mm'."""
    return d.strftime("%d/%m") if d else ""


def formatar_numero(n, casas=2):
    """De: numero no formato BR (1.234,56)."""
    if n is None:
        n = 0
    try:
        if n != n:  # NaN
            n = 0
    except TypeError:
        n = 0
    texto = f"{n:,.{casas}f}"
    return texto.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def formatar_reais(n):
    """Pr: 'R$ 1.234,56'."""
    return "R$ " + formatar_numero(n)


def formatar_pct(n):
    """fl: '12,3%'."""
    return formatar_numero((n or 0) * 100, 1) + "%"


def achar_coluna(cabecalho, aliases):
    """Kt: acha o indice da coluna cujo nome (normalizado) bate com algum alias.
    1a passada: igualdade exata. 2a passada: contém (substring)."""
    normalizados = [normalizar(c) for c in cabecalho]
    aliases_norm = [normalizar(a) for a in aliases]
    for alias in aliases_norm:
        for i, col in enumerate(normalizados):
            if col == alias:
                return i
    for alias in aliases_norm:
        for i, col in enumerate(normalizados):
            if alias in col:
                return i
    return -1


def classificar_especialidade(texto):
    """_1: classifica a especialidade/equipamento em CAMINHAO / BATE-VOLTA / COLHEDORA / TRANSBORDO."""
    r = normalizar(texto)
    if "COLHED" in r:
        return "COLHEDORA"
    if "TRANSBORD" in r:
        return "TRANSBORDO"
    if "BATE" in r:
        return "BATE-VOLTA"
    if "CAMINH" in r or "CANAVIEIR" in r or "MOTORISTA" in r:
        return "CAMINHAO"
    if "TRATOR" in r:
        return "TRANSBORDO"
    return "CAMINHAO"


_RE_III = re.compile(r"\bIII\b")
_RE_II = re.compile(r"\bII\b")
_RE_I = re.compile(r"\bI\b")


def salario_padrao_por_funcao(funcao):
    """Dk: salario base padrao quando a planilha nao trouxe salario, deduzido do cargo (I/II/III/Lider)."""
    r = normalizar(funcao)
    if "LIDER" in r:
        return 3348.46
    if _RE_III.search(r):
        return 2276.32
    if _RE_II.search(r):
        return 2066.15
    if _RE_I.search(r):
        return 1895.50
    return 0

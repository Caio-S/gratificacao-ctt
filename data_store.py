"""Camada de acesso a dados. Hoje guarda tudo em memoria do processo (efemero,
some ao reiniciar o servidor). Pensada pra depois virar consultas a um banco
real sem precisar mexer nas rotas do app.py nem no frontend - só trocar as
funcoes daqui."""

_state = {
    "funcionarios": [],
    "pesagens": [],
    "frotas": [],
    "parametros": None,  # populado em fase 3 com os valores padrao
    "periodo": {"inicio": "2026-06-16", "fim": "2026-07-15"},  # mesmo padrao do artefato original
    "dias_base": 25,
}


def get_funcionarios():
    return _state["funcionarios"]


def set_funcionarios(lista):
    _state["funcionarios"] = lista


def get_pesagens():
    return _state["pesagens"]


def set_pesagens(lista):
    _state["pesagens"] = lista


def get_frotas():
    return _state["frotas"]


def set_frotas(lista):
    _state["frotas"] = lista


def get_parametros():
    return _state["parametros"]


def set_parametros(params):
    _state["parametros"] = params


def get_periodo():
    return _state["periodo"]


def set_periodo(inicio, fim):
    _state["periodo"] = {"inicio": inicio, "fim": fim}


def get_dias_base():
    return _state["dias_base"]


def set_dias_base(dias):
    _state["dias_base"] = dias


def limpar_tudo():
    _state["funcionarios"] = []
    _state["pesagens"] = []
    _state["frotas"] = []

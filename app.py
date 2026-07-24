import os
from datetime import date, datetime
from decimal import Decimal
from functools import wraps

from dotenv import load_dotenv

load_dotenv()

import openpyxl
from flask import Flask, jsonify, render_template, request, session

import calculo
import calculo_defaults
import data_store
import parsers
from utils import parse_data

app = Flask(__name__)
app.secret_key = os.environ["SECRET_KEY"]


def requer_login(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "papel" not in session:
            return jsonify({"error": "Não autenticado."}), 401
        return f(*args, **kwargs)
    return wrapper


def requer_papel(*papeis_permitidos):
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            papel = session.get("papel")
            if not papel:
                return jsonify({"error": "Não autenticado."}), 401
            if papel not in papeis_permitidos:
                return jsonify({"error": "Sem permissão para esta ação."}), 403
            return f(*args, **kwargs)
        return wrapper
    return decorator


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def status():
    return jsonify({"ok": True})


def _usuario_sessao_json():
    return {"username": session["username"], "papel": session["papel"], "nome": session.get("nome") or ""}


@app.route("/api/precisa-bootstrap")
def precisa_bootstrap():
    return jsonify({"precisaBootstrap": not data_store.existe_algum_usuario()})


@app.route("/api/bootstrap", methods=["POST"])
def bootstrap():
    if data_store.existe_algum_usuario():
        return jsonify({"error": "Sistema já tem usuários cadastrados."}), 403
    payload = request.get_json(force=True)
    username = (payload.get("username") or "").strip()
    senha = payload.get("senha") or ""
    nome = (payload.get("nome") or "").strip()
    if not username or len(senha) < 6:
        return jsonify({"error": "Informe usuário e senha (mínimo 6 caracteres)."}), 400
    usuario = data_store.criar_usuario(username, senha, "diretoria", nome)
    session["user_id"] = usuario["id"]
    session["username"] = usuario["username"]
    session["papel"] = usuario["papel"]
    session["nome"] = usuario["nome"]
    return jsonify(_usuario_sessao_json())


@app.route("/api/login", methods=["POST"])
def login():
    payload = request.get_json(force=True)
    username = (payload.get("username") or "").strip()
    senha = payload.get("senha") or ""
    usuario = data_store.autenticar(username, senha)
    if not usuario:
        return jsonify({"error": "Usuário ou senha inválidos."}), 401
    session["user_id"] = usuario["id"]
    session["username"] = usuario["username"]
    session["papel"] = usuario["papel"]
    session["nome"] = usuario["nome"]
    return jsonify(_usuario_sessao_json())


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return "", 204


@app.route("/api/me")
def me():
    if "papel" not in session:
        return jsonify({"error": "Não autenticado."}), 401
    return jsonify(_usuario_sessao_json())


def _ler_matriz(arquivo):
    """Le um arquivo .xlsx enviado (multipart) e devolve a primeira aba como
    lista de listas, igual ao sheet_to_json({header:1}) do SheetJS."""
    wb = openpyxl.load_workbook(arquivo, data_only=True, read_only=True)
    ws = wb.worksheets[0]
    matriz = [[("" if v is None else v) for v in row] for row in ws.iter_rows(values_only=True)]
    wb.close()
    return matriz


def _funcionario_json(f):
    d = dict(f)
    if isinstance(d.get("admissao"), date):
        d["admissao"] = d["admissao"].isoformat()
    return d


def _pesagem_json(p):
    d = dict(p)
    if isinstance(d.get("data"), date):
        d["data"] = d["data"].isoformat()
    return d


@app.route("/api/import/funcionarios", methods=["POST"])
@requer_papel("coordenador", "gerente", "diretoria")
def import_funcionarios():
    arquivo = request.files.get("arquivo")
    if not arquivo:
        return jsonify({"error": "Nenhum arquivo enviado."}), 400
    try:
        matriz = _ler_matriz(arquivo)
        lista = parsers.parse_funcionarios(matriz, data_store.get_dias_base())
    except parsers.ErroImportacao as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # arquivo corrompido, formato inesperado etc.
        return jsonify({"error": f"Falha ao importar funcionários: {exc}"}), 400
    data_store.set_funcionarios(lista)
    return jsonify({"ok": True, "total": len(lista), "nomeArquivo": arquivo.filename})


@app.route("/api/import/frotas", methods=["POST"])
@requer_papel("coordenador", "gerente", "diretoria")
def import_frotas():
    arquivo = request.files.get("arquivo")
    if not arquivo:
        return jsonify({"error": "Nenhum arquivo enviado."}), 400
    try:
        matriz = _ler_matriz(arquivo)
        lista = parsers.parse_frotas(matriz)
    except parsers.ErroImportacao as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Falha ao importar disponibilidade: {exc}"}), 400
    data_store.set_frotas(lista)
    return jsonify({"ok": True, "total": len(lista), "nomeArquivo": arquivo.filename})


@app.route("/api/import/pesagens", methods=["POST"])
@requer_papel("coordenador", "gerente", "diretoria")
def import_pesagens():
    arquivo = request.files.get("arquivo")
    if not arquivo:
        return jsonify({"error": "Nenhum arquivo enviado."}), 400
    try:
        matriz = _ler_matriz(arquivo)
        resultado = parsers.parse_pesagens(matriz)
    except parsers.ErroImportacao as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Falha ao importar produções: {exc}"}), 400
    data_store.set_pesagens(resultado["regs"])
    return jsonify({
        "ok": True,
        "total": len(resultado["regs"]),
        "temKm": resultado["tem_km"],
        "colunas": resultado["colunas"],
        "nomeArquivo": arquivo.filename,
    })


@app.route("/api/seed", methods=["POST"])
@requer_papel("coordenador", "gerente", "diretoria")
def seed_demo():
    periodo = data_store.get_periodo()
    inicio = parse_data(periodo["inicio"])
    fim = parse_data(periodo["fim"])
    if not inicio or not fim:
        return jsonify({"error": "Período inválido."}), 400
    gerado = parsers.gerar_dados_demo(inicio, fim)
    data_store.set_funcionarios(gerado["funcionarios"])
    data_store.set_pesagens(gerado["pesagens"])
    return jsonify({"ok": True, "totalFuncionarios": len(gerado["funcionarios"]), "totalPesagens": len(gerado["pesagens"])})


@app.route("/api/dados", methods=["GET"])
@requer_login
def get_dados():
    d = data_store.get_dados_bundle()
    return jsonify({
        "funcionarios": [_funcionario_json(f) for f in d["funcionarios"]],
        "pesagens": [_pesagem_json(p) for p in d["pesagens"]],
        "frotas": d["frotas"],
        "periodo": d["periodo"],
        "diasBase": d["dias_base"],
    })


@app.route("/api/dados", methods=["DELETE"])
@requer_papel("gerente", "diretoria")
def limpar_dados():
    data_store.limpar_tudo()
    return "", 204


@app.route("/api/periodo", methods=["PUT"])
@requer_papel("gerente", "diretoria")
def set_periodo():
    payload = request.get_json(force=True)
    inicio = payload.get("inicio")
    fim = payload.get("fim")
    dias_base = payload.get("diasBase")
    if not inicio or not fim:
        return jsonify({"error": "Informe início e fim do período."}), 400
    if not parse_data(inicio) or not parse_data(fim):
        return jsonify({"error": "Datas inválidas."}), 400
    data_store.set_periodo(inicio, fim)
    if dias_base:
        data_store.set_dias_base(int(dias_base))
    return jsonify({"periodo": data_store.get_periodo(), "diasBase": data_store.get_dias_base()})


@app.route("/api/parametros", methods=["GET"])
@requer_login
def get_parametros():
    return jsonify(data_store.get_parametros())


@app.route("/api/parametros", methods=["PUT"])
@requer_papel("gerente", "diretoria")
def set_parametros():
    payload = request.get_json(force=True)
    data_store.set_parametros(payload)
    return jsonify(data_store.get_parametros())


@app.route("/api/parametros/restaurar-faixas", methods=["POST"])
@requer_papel("gerente", "diretoria")
def restaurar_faixas():
    atual = data_store.get_parametros()
    atual.update(calculo_defaults.faixas_padrao())
    data_store.set_parametros(atual)
    return jsonify(atual)


def _semana_json(sem):
    d = dict(sem)
    d.pop("_vCod", None)
    d["dias"] = {iso: {k: v for k, v in dia.items() if k != "_vCod"} for iso, dia in d.get("dias", {}).items()}
    return d


def _agregado_json(k):
    d = dict(k)
    d.pop("_vCod", None)
    if isinstance(d.get("admissao"), date):
        d["admissao"] = d["admissao"].isoformat()
    d["semanas"] = {str(idx): _semana_json(sem) for idx, sem in d.get("semanas", {}).items()}
    return d


@app.route("/api/calculo", methods=["GET"])
@requer_login
def get_calculo():
    d = data_store.get_calculo_inputs()
    inicio = parse_data(d["periodo"]["inicio"])
    fim = parse_data(d["periodo"]["fim"])
    if not inicio or not fim:
        return jsonify({"error": "Período inválido."}), 400
    resultado = calculo.calcular(
        d["funcionarios"],
        d["pesagens"],
        inicio,
        fim,
        d["dias_base"],
        d["parametros"],
        d["ajustes"],
    )
    return jsonify({
        "lista": [_agregado_json(k) for k in resultado["lista"]],
        "nSem": resultado["nSem"],
    })


@app.route("/api/ajuste/<mat>", methods=["PUT"])
@requer_papel("gerente", "diretoria")
def set_ajuste(mat):
    payload = request.get_json(force=True)
    pct = payload.get("pct")
    obs = (payload.get("obs") or "").strip()
    if pct is None:
        return jsonify({"error": "Informe o percentual do ajuste."}), 400
    if not obs:
        return jsonify({"error": "Informe a observação justificando o ajuste."}), 400
    data_store.set_ajuste(mat, float(pct), obs)
    return jsonify({"ok": True})


@app.route("/api/ajuste/<mat>", methods=["DELETE"])
@requer_papel("gerente", "diretoria")
def remover_ajuste(mat):
    data_store.remover_ajuste(mat)
    return "", 204


def _ajuste_pendente_json(row):
    d = dict(row)
    for campo in ("criado_em", "aprovado_gerente_em", "aprovado_diretoria_em", "rejeitado_em"):
        if isinstance(d.get(campo), datetime):
            d[campo] = d[campo].isoformat()
    if isinstance(d.get("pct"), Decimal):
        d["pct"] = float(d["pct"])
    return {
        "id": d["id"],
        "mat": d["mat"],
        "pct": d["pct"],
        "obs": d["obs"],
        "criadoPor": d["criado_por"],
        "criadoEm": d["criado_em"],
        "status": d["status"],
        "aprovadoGerente": d["aprovado_gerente"],
        "aprovadoGerentePor": d["aprovado_gerente_por"],
        "aprovadoDiretoria": d["aprovado_diretoria"],
        "aprovadoDiretoriaPor": d["aprovado_diretoria_por"],
        "rejeitadoPor": d["rejeitado_por"],
        "motivoRejeicao": d["motivo_rejeicao"],
    }


@app.route("/api/ajustes-pendentes", methods=["GET"])
@requer_papel("gerente", "diretoria")
def listar_ajustes_pendentes():
    return jsonify([_ajuste_pendente_json(r) for r in data_store.listar_ajustes_pendentes()])


@app.route("/api/ajustes-pendentes", methods=["POST"])
@requer_papel("coordenador")
def criar_ajuste_pendente():
    payload = request.get_json(force=True)
    mat = (payload.get("mat") or "").strip()
    pct = payload.get("pct")
    obs = (payload.get("obs") or "").strip()
    if not mat or pct is None:
        return jsonify({"error": "Informe o colaborador e o percentual."}), 400
    if not obs:
        return jsonify({"error": "Informe a observação justificando o ajuste."}), 400
    row = data_store.criar_ajuste_pendente(mat, float(pct), obs, session["username"])
    return jsonify(_ajuste_pendente_json(row))


@app.route("/api/ajustes-pendentes/aprovar", methods=["POST"])
@requer_papel("gerente", "diretoria")
def aprovar_ajustes_pendentes():
    payload = request.get_json(force=True)
    ids = payload.get("ids") or []
    if not ids:
        return jsonify({"error": "Selecione ao menos um ajuste."}), 400
    aplicados = data_store.aprovar_ajustes(ids, session["papel"], session["username"])
    return jsonify({"ok": True, "aplicados": aplicados})


@app.route("/api/ajustes-pendentes/<int:ajuste_id>/rejeitar", methods=["POST"])
@requer_papel("gerente", "diretoria")
def rejeitar_ajuste_pendente(ajuste_id):
    payload = request.get_json(force=True)
    motivo = (payload.get("motivo") or "").strip()
    if not motivo:
        return jsonify({"error": "Informe o motivo da rejeição."}), 400
    data_store.rejeitar_ajuste(ajuste_id, session["username"], motivo)
    return "", 204


def _usuario_json(u):
    d = dict(u)
    if isinstance(d.get("criado_em"), datetime):
        d["criado_em"] = d["criado_em"].isoformat()
    return d


@app.route("/api/usuarios", methods=["GET"])
@requer_papel("diretoria")
def listar_usuarios():
    return jsonify([_usuario_json(u) for u in data_store.listar_usuarios()])


@app.route("/api/usuarios", methods=["POST"])
@requer_papel("diretoria")
def criar_usuario_rota():
    payload = request.get_json(force=True)
    username = (payload.get("username") or "").strip()
    senha = payload.get("senha") or ""
    papel = payload.get("papel")
    nome = (payload.get("nome") or "").strip()
    if not username or len(senha) < 6:
        return jsonify({"error": "Informe usuário e senha (mínimo 6 caracteres)."}), 400
    if papel not in data_store.PAPEIS:
        return jsonify({"error": "Papel inválido."}), 400
    if data_store.buscar_usuario_por_username(username):
        return jsonify({"error": "Já existe um usuário com esse nome."}), 400
    return jsonify(_usuario_json(data_store.criar_usuario(username, senha, papel, nome)))


@app.route("/api/usuarios/<int:user_id>", methods=["PUT"])
@requer_papel("diretoria")
def atualizar_usuario_rota(user_id):
    payload = request.get_json(force=True)
    papel = payload.get("papel")
    if papel is not None and papel not in data_store.PAPEIS:
        return jsonify({"error": "Papel inválido."}), 400
    senha = payload.get("senha") or None
    if senha and len(senha) < 6:
        return jsonify({"error": "Senha deve ter ao menos 6 caracteres."}), 400
    data_store.atualizar_usuario(
        user_id, papel=papel, nome=payload.get("nome"), ativo=payload.get("ativo"), senha=senha,
    )
    return jsonify({"ok": True})


@app.route("/api/usuarios/<int:user_id>", methods=["DELETE"])
@requer_papel("diretoria")
def remover_usuario_rota(user_id):
    if user_id == session.get("user_id"):
        return jsonify({"error": "Você não pode remover seu próprio usuário."}), 400
    data_store.remover_usuario(user_id)
    return "", 204


if __name__ == "__main__":
    app.run(debug=True, port=5002)

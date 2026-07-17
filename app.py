from datetime import date

import openpyxl
from flask import Flask, jsonify, render_template, request

import calculo
import calculo_defaults
import data_store
import parsers
from utils import parse_data

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def status():
    return jsonify({"ok": True})


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
def get_dados():
    return jsonify({
        "funcionarios": [_funcionario_json(f) for f in data_store.get_funcionarios()],
        "pesagens": [_pesagem_json(p) for p in data_store.get_pesagens()],
        "frotas": data_store.get_frotas(),
        "periodo": data_store.get_periodo(),
        "diasBase": data_store.get_dias_base(),
    })


@app.route("/api/dados", methods=["DELETE"])
def limpar_dados():
    data_store.limpar_tudo()
    return "", 204


@app.route("/api/periodo", methods=["PUT"])
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
def get_parametros():
    return jsonify(data_store.get_parametros())


@app.route("/api/parametros", methods=["PUT"])
def set_parametros():
    payload = request.get_json(force=True)
    data_store.set_parametros(payload)
    return jsonify(data_store.get_parametros())


@app.route("/api/parametros/restaurar-faixas", methods=["POST"])
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
def get_calculo():
    inicio = parse_data(data_store.get_periodo()["inicio"])
    fim = parse_data(data_store.get_periodo()["fim"])
    if not inicio or not fim:
        return jsonify({"error": "Período inválido."}), 400
    resultado = calculo.calcular(
        data_store.get_funcionarios(),
        data_store.get_pesagens(),
        inicio,
        fim,
        data_store.get_dias_base(),
        data_store.get_parametros(),
    )
    return jsonify({
        "lista": [_agregado_json(k) for k in resultado["lista"]],
        "nSem": resultado["nSem"],
    })


if __name__ == "__main__":
    app.run(debug=True, port=5002)

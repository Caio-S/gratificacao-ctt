"""Parametros de calculo da gratificacao, portados fielmente dos valores padrao
do artefato original (constantes M1/F1/Ok/C/D/V/Q/x). Cada especialidade tem seu
proprio modo de calculo:
  - CAMINHAO / BATE-VOLTA: "faixa" -> R$/t varia por faixa de km da viagem
    (tabelaCanavieiro / tabelaBateVolta).
  - COLHEDORA / TRANSBORDO: "fixo" -> R$/t fixo, com teto proprio (tetoColhedora /
    tetoTransbordo) que ja embute a proporcionalidade dos dias trabalhados.
"""

import copy

_TAXAS_FAIXA_PADRAO = [
    0.1152, 0.1332, 0.1512, 0.1728, 0.1908, 0.2088, 0.2268, 0.2484, 0.2664, 0.3276,
    0.3492, 0.3708, 0.4284, 0.45, 0.648, 0.6732, 0.6984, 0.7236, 0.7524, 0.7776,
    0.8064, 0.8388, 0.8676, 0.9, 0.9288,
]


def _tabela_faixas_padrao():
    return [{"ini": i * 5 + 1, "fim": i * 5 + 5, "rate": r} for i, r in enumerate(_TAXAS_FAIXA_PADRAO)]


def parametros_padrao():
    """Devolve uma copia nova (nao compartilhada) dos parametros padrao."""
    return {
        "modoCalculo": "pesagem",
        "aplicarTeto": False,
        "tabelaCanavieiro": _tabela_faixas_padrao(),
        "tabelaBateVolta": _tabela_faixas_padrao(),
        "especialidades": [
            {"chave": "CAMINHAO", "rotulo": "Caminhão canavieiro", "modo": "faixa",
             "tabela": "canavieiro", "valorProd": 1275, "salBase": 2276.32},
            {"chave": "BATE-VOLTA", "rotulo": "Caminhão bate e volta", "modo": "faixa",
             "tabela": "bv", "valorProd": 1275, "salBase": 2276.32},
            {"chave": "COLHEDORA", "rotulo": "Colhedora de cana", "modo": "fixo",
             "rate": 0.255, "valorProd": 1275, "salBase": 2276.32},
            {"chave": "TRANSBORDO", "rotulo": "Trator transbordo", "modo": "fixo",
             "rate": 0.24, "valorProd": 600, "salBase": 2066.15},
        ],
        "frotaConfig": {"metaDiaColhed": 600, "valorColhed": 1275, "metaDiaTransb": 290.3226, "valorTransb": 400},
        "tetoColhedora": {"metaDia": 160, "valor": 1275},
        "tetoTransbordo": {"metaDia": 85, "valor": 600},
    }


def faixas_padrao():
    """So as duas tabelas de faixa (usado pelo botao 'Restaurar padrão')."""
    return copy.deepcopy({
        "tabelaCanavieiro": _tabela_faixas_padrao(),
        "tabelaBateVolta": _tabela_faixas_padrao(),
    })

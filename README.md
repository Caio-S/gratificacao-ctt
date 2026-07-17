# Gratificação CTT — Motoristas & Operadores · CRV Industrial

Apuração da gratificação de produção de motoristas (caminhão canavieiro / bate e volta) e operadores (colhedora / transbordo): importação de planilhas Excel, parâmetros de cálculo editáveis, cálculo por colaborador, relatório semanal, painel executivo e extrato individual.

Back-end Flask, sem banco de dados por enquanto — os dados importados (funcionários, pesagens, disponibilidade de frotas, parâmetros) ficam em memória do processo (`data_store.py`) e se perdem ao reiniciar o servidor. A camada de acesso a dados já é isolada das rotas e do front-end para facilitar a troca por um banco real no futuro.

## Rodar local

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py        # http://localhost:5002
```

Na aba **Dados**, defina o período de apuração e importe as 3 planilhas (funcionários, disponibilidade de frotas, pesagens/produção) ou clique em "Carregar dados de demonstração" para gerar dados fictícios determinísticos.

## Deploy (Render)

Sem banco de dados nem login — o `render.yaml` já aponta para o `gunicorn app:app`. Basta criar um Web Service no [Render](https://render.com) apontando para este repositório (ele detecta o `render.yaml`). Como os dados vivem em memória, cada deploy/restart limpa tudo — sem persistência entre reinicializações, sem múltiplas instâncias simultâneas.

## Estrutura

- `app.py` — rotas Flask + API REST (`/api/dados`, `/api/import/*`, `/api/parametros`, `/api/calculo`, `/api/periodo`, `/api/seed`)
- `data_store.py` — estado em memória (funcionários, pesagens, frotas, parâmetros, período)
- `calculo_defaults.py` — valores padrão dos parâmetros de cálculo (faixas de km, tetos, especialidades)
- `parsers.py` — leitura das planilhas Excel e geração dos dados de demonstração
- `calculo.py` — motor de cálculo da gratificação (agregação por colaborador, teto, prorata de dias)
- `utils.py` — funções utilitárias (formatação BR, parsing de datas/números, classificação de especialidade)
- `templates/index.html`, `static/app.js`, `static/style.css` — front-end (SPA em JS puro, sem build step)

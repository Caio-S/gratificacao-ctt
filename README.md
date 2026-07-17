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

## Contribuindo (setup para outra pessoa)

Pré-requisitos na máquina de quem for mexer no projeto:

- **Git** instalado e autenticado no GitHub (login via credential manager, SSH key ou token de acesso).
- **Acesso ao repositório** — peça para ser adicionado como colaborador (se o repo for privado) ou dê "Fork" (se for público).
- **Python 3.10+** instalado.
- Opcional, para usar o Claude Code: **Node.js** instalado + `npm install -g @anthropic-ai/claude-code` e login com a conta Anthropic.

Passo a passo:

```
git clone https://github.com/Caio-S/gratificacao-ctt.git
cd gratificacao-ctt

python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

python app.py        # http://localhost:5002
```

Fluxo de alterações (evita quebrar a produção, já que o Render redeploya a cada push em `main`):

```
git checkout -b nome-da-mudanca
# ... alterações ...
git add .
git commit -m "descrição da mudança"
git push -u origin nome-da-mudanca
```

Depois abra um Pull Request no GitHub da branch para `main`. Só dar merge após revisão — não commitar direto em `main`.

Quem tiver o Claude Code instalado pode simplesmente rodar `claude` dentro da pasta clonada e pedir as alterações — ele cuida de criar a branch, commitar e abrir o PR.

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

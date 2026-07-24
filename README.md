# Gratificação CTT — Motoristas & Operadores · CRV Industrial

Apuração da gratificação de produção de motoristas (caminhão canavieiro / bate e volta) e operadores (colhedora / transbordo): importação de planilhas Excel, parâmetros de cálculo editáveis, cálculo por colaborador, relatório semanal, painel executivo e extrato individual.

Back-end Flask com persistência em Postgres (Supabase) — os dados importados (funcionários, pesagens, disponibilidade de frotas, parâmetros) ficam salvos no banco (`data_store.py`) e sobrevivem a redeploys e reinícios do servidor.

## Banco de dados (Supabase)

Pode reaproveitar um projeto Supabase já existente (ex.: o do Catálogo CH570) — a tabela usada aqui (`ctt_app_state`) é isolada por nome, não colide com outras tabelas. Se preferir isolar de vez, crie um projeto novo dedicado.

1. Em [supabase.com](https://supabase.com), no projeto escolhido, abra o **SQL Editor** e rode:
   ```sql
   create table if not exists ctt_app_state (
     key text primary key,
     value jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );
   ```
3. Em **Project Settings → Database → Connection string**, copie a string no modo **Transaction pooler** (porta 6543) — combina melhor com o padrão de conexão do app (abre e fecha uma conexão por requisição).
4. Defina essa string como variável de ambiente `DATABASE_URL` (veja abaixo, local e no Render).

## Rodar local

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Crie um arquivo `.env` na raiz do projeto (não é versionado) com:
```
DATABASE_URL=postgresql://usuario:senha@host:6543/postgres
```

```
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

Sem login — o `render.yaml` já aponta para o `gunicorn app:app`. Basta criar um Web Service no [Render](https://render.com) apontando para este repositório (ele detecta o `render.yaml`). Em **Environment**, adicione a variável `DATABASE_URL` com a connection string do Supabase (passo acima) — sem ela o app não sobe.

## Estrutura

- `app.py` — rotas Flask + API REST (`/api/dados`, `/api/import/*`, `/api/parametros`, `/api/calculo`, `/api/periodo`, `/api/seed`)
- `data_store.py` — persistência em Postgres/Supabase (funcionários, pesagens, frotas, parâmetros, período)
- `calculo_defaults.py` — valores padrão dos parâmetros de cálculo (faixas de km, tetos, especialidades)
- `parsers.py` — leitura das planilhas Excel e geração dos dados de demonstração
- `calculo.py` — motor de cálculo da gratificação (agregação por colaborador, teto, prorata de dias)
- `utils.py` — funções utilitárias (formatação BR, parsing de datas/números, classificação de especialidade)
- `templates/index.html`, `static/app.js`, `static/style.css` — front-end (SPA em JS puro, sem build step)

# Dashboard de Usina Solar

Projeto em Next.js preparado para deploy na Vercel, com integracao ao GoodWe SEMS+ (antigo SEMS Portal) por API nao oficial.

> Em setembro de 2026 a GoodWe migrou o SEMS Portal para o SEMS+ e as rotas antigas (`www.semsportal.com/api/...`) passaram a devolver dados vazios. O cliente em `src/lib/sems/client.ts` usa a API Web do SEMS+ (`semsplus.goodwe.com`).

## O que entrega

- metricas de geracao hoje e no mes
- economia estimada em reais
- performance diaria contra meta
- status da usina e dos inversores
- grafico horario de potencia
- historico diario recente
- cache no backend para reduzir carga na API externa

## Funcionalidades do painel

- **Alertas e saúde da usina**: inversores parados em horário de sol, dias sem registro, dias com geração muito abaixo do normal, queda de rendimento nas últimas 2 semanas e aviso de chuva para amanhã.
- **Meta do mês**: progresso, projeção, kWh/dia necessários para bater a meta e comparação do acumulado do ano com o ano anterior.
- **Análise de geração**: qualquer mês (dia a dia, com melhor/pior dia, média, dias abaixo da meta, comparação com mês anterior e ano anterior), últimos 6 ou 12 meses (com o mesmo mês do ano anterior ao lado), detalhe de um dia específico e exportação em CSV.
- **Inversores**: status, potência, geração do dia/mês/total e participação de cada um na geração de hoje.

## Arquitetura

- `src/app/api/solar/route.ts`: endpoint server-side para concentrar acesso ao SEMS
- `src/app/api/solar/history/route.ts`: historico por dia ou por mes (`?dimension=day|month&start=AAAA-MM-DD&end=AAAA-MM-DD`)
- `src/components/period-analysis.tsx` e `src/components/plant-health.tsx`: analise por periodo, alertas e meta
- `src/lib/sems/client.ts`: cliente HTTP da integracao nao oficial
- `src/lib/solar-dashboard.ts`: transformacao do payload do SEMS para o contrato do frontend
- `src/components/dashboard-shell.tsx`: dashboard client-side com polling a cada 60s (mostra o erro do SEMS+ na tela se a primeira leitura falhar)
- `src/lib/env.ts`: validacao forte das variaveis de ambiente com `zod`

## Variaveis de ambiente

Copie `.env.example` para `.env.local` e preencha:

```env
SEMS_USER=seu_email
SEMS_PASS=sua_senha
SEMS_PLANT_ID=
TARIFA_KWH=0.90
META_DIARIA=1500
SEMS_CACHE_TTL_MS=60000
DASHBOARD_PASSWORD=sua_senha_do_painel
```

- `DASHBOARD_PASSWORD` e a senha da tela de bloqueio. Se nao for definida, a senha padrao e `solee2026`.
- O acesso fica salvo num cookie assinado; trocar a senha desconecta todos os aparelhos.

### Observacoes

- `SEMS_PLANT_ID` e opcional, mas recomendado para producao (e o mesmo ID da usina que aparece na URL do SEMS+).
- A conta precisa conseguir entrar em https://semsplus.goodwe.com e ter aceitado os termos de uso la ao menos uma vez.
- O SEMS+ nao expoe uma curva de potencia do dia conhecida; o grafico horario e montado com as leituras feitas pelo proprio dashboard.
- Se nao for informado, o backend tenta descobrir a primeira usina da conta.
- `META_DIARIA` alimenta o calculo de performance.
- `TARIFA_KWH` alimenta a estimativa de economia.

## Desenvolvimento local

```bash
npm install
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000).

## Validacao

```bash
npm run lint
npm run build
```

## Deploy na Vercel

1. Crie um novo projeto importando este repositorio.
2. Configure as variaveis de ambiente no painel da Vercel.
3. Faça o deploy.

## Risco conhecido

Essa integracao usa endpoints nao oficiais do SEMS Portal. Isso significa que a GoodWe pode alterar autenticacao, payloads ou rotas sem aviso. Para producao real, vale acompanhar logs do endpoint `/api/solar` e considerar migracao para uma API oficial assim que estiver disponivel para sua conta.

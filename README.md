# Dashboard de Usina Solar

Projeto em Next.js 16 preparado para deploy na Vercel, com integracao ao GoodWe SEMS Portal por API nao oficial.

## O que entrega

- metricas de geracao hoje e no mes
- economia estimada em reais
- performance diaria contra meta
- status da usina e dos inversores
- grafico horario de potencia
- historico diario recente
- cache no backend para reduzir carga na API externa

## Arquitetura

- `src/app/api/solar/route.ts`: endpoint server-side para concentrar acesso ao SEMS
- `src/lib/sems/client.ts`: cliente HTTP da integracao nao oficial
- `src/lib/solar-dashboard.ts`: transformacao do payload do SEMS para o contrato do frontend
- `src/components/dashboard-shell.tsx`: dashboard client-side com polling a cada 60s
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
```

### Observacoes

- `SEMS_PLANT_ID` e opcional, mas recomendado para producao.
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

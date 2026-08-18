# Catálogo Vesco

Site do catálogo online da Vesco, com efeito de "virar página" (estilo revista) e
um botão que gera o catálogo em PDF (com fotos) na hora, puxando os produtos
direto da sua planilha do Google Sheets — a mesma que o Script Catálogo já
mantém atualizada automaticamente.

## O que tem aqui

- `server.js` — servidor único (Node + Express) que serve o site e gera o PDF
  (usa Puppeteer para transformar o catálogo em PDF, com fotos incluídas).
- `public/` — o site (HTML + CSS + JS puro, sem framework, sem etapa de build).
- `render.yaml` — configuração para publicar de graça no Render em poucos cliques.

## Rodando no seu computador (para testar antes de publicar)

Pré-requisito: [Node.js](https://nodejs.org) instalado (versão 18 ou mais nova).

```bash
npm install
npm start
```

Depois abra http://localhost:3000 no navegador.

## Publicando online (recomendado: Render, gratuito)

O Render tem um plano gratuito que serve bem para esse catálogo: ele "dorme"
depois de 15 minutos sem acesso e demora uns instantes para acordar na
próxima visita — normal para um catálogo de uso interno/comercial, sem custo.

1. Crie uma conta em [render.com](https://render.com) (dá para entrar com o GitHub).
2. Suba esta pasta para um repositório no GitHub (ou peça para eu gerar um
   .zip pronto pra você arrastar, se preferir não usar GitHub).
3. No Render, clique em **New +** → **Web Service** e conecte o repositório.
4. Configuração:
   - **Build Command:** `npm install && npx puppeteer browsers install chrome`
   - **Start Command:** `npm start`
   - **Plan:** Free
5. Clique em **Create Web Service**. Em alguns minutos você recebe um link
   tipo `https://catalogo-vesco.onrender.com` — esse é o site pra compartilhar.

Se preferir, o arquivo `render.yaml` já vem pronto: no Render, use a opção
**Blueprint** e aponte para o repositório — ele configura tudo sozinho.

**Sobre o Build Command com `npx puppeteer browsers install chrome`:** é
necessário porque o `npm install` sozinho às vezes não baixa o navegador
Chrome que o Puppeteer precisa pra gerar o PDF (o site sobe normalmente, mas
os botões de PDF/revista digital dão erro de "Não foi possível encontrar o
Chrome"). Esse comando extra garante que o Chrome seja baixado durante o
build. Se você já criou o serviço sem esse comando, é só ir em **Settings**
→ **Build Command** no painel do Render, colar o comando completo acima, e
rodar um **Manual Deploy** de novo.

**Se mesmo assim continuar dizendo "Could not find Chrome":** é um
comportamento específico do Render — a pasta onde o Chrome é baixado por
padrão (fora da pasta do projeto) não é sempre preservada entre o build e a
execução do serviço. A correção é apontar essa pasta pra dentro da pasta do
projeto, através da variável de ambiente `PUPPETEER_CACHE_DIR` (o
`render.yaml` já vem com ela configurada). Se o seu serviço já existia antes
dessa variável, adicione manualmente em **Environment**, no Render:

- Nome: `PUPPETEER_CACHE_DIR`
- Valor: `/opt/render/project/.cache/puppeteer`

**Se der um erro do tipo "The browser folder exists but the executable is
missing":** esse é um bug conhecido do Puppeteer especificamente no Node.js
26 — o download do Chrome é feito, mas a extração dos arquivos para
silenciosamente no meio, sem mostrar erro nenhum, e só quebra depois, quando
o site tenta usar o Chrome (mais detalhes:
[puppeteer/puppeteer#14957](https://github.com/puppeteer/puppeteer/issues/14957)).
A correção é fixar o Render numa versão do Node anterior à 26 (o `render.yaml`
já vem configurado assim). Se o seu serviço já existia antes dessa variável,
adicione manualmente em **Environment**:

- Nome: `NODE_VERSION`
- Valor: `20`

Depois disso, rode outro **Manual Deploy** → **Clear build cache & deploy**
(de novo com cache limpo, pra descartar a instalação corrompida anterior).

## Publicando em outras hospedagens (Hostinger, cPanel, etc.)

Hospedagens com painel próprio de Node.js (hPanel da Hostinger, cPanel com
Node.js Selector, e parecidos) normalmente não têm um campo de "Build
Command" como o Render — elas só rodam `npm install` sozinho depois do
deploy. Por isso, o `package.json` já vem com um script `postinstall` que
roda automaticamente logo depois do `npm install`, em qualquer hospedagem,
e baixa o Chrome que o Puppeteer precisa — sem precisar configurar nada a
mais no painel.

**Se mesmo assim os botões de PDF/revista digital derem erro de "Could not
find Chrome"** (aparece nos logs de execução do site, mencionando "you did
not perform an installation" ou "your cache path is incorrectly
configured"): normalmente é porque esse tipo de hospedagem compartilhada
bloqueia scripts de pós-instalação por segurança (então o `postinstall`
acima nem chega a rodar). Nesse caso:

1. Veja se o painel oferece algum "Terminal" ou acesso SSH pra essa
   aplicação Node.js — se tiver, rode manualmente, na pasta do projeto:
   `npx puppeteer browsers install chrome`
2. Se não tiver terminal disponível, esse tipo de hospedagem compartilhada
   pode simplesmente não suportar o Puppeteer (ele precisa conseguir abrir
   um processo de navegador de verdade por trás — muitos planos
   compartilhados não permitem isso). Nesse caso, a alternativa mais
   simples é publicar no Render (veja as instruções acima), que já vem
   testado e funcionando com este projeto.

## Limite de produtos por geração (plano gratuito)

Gerar o PDF ou a revista digital usa o Chrome de verdade rodando por trás —
com centenas de produtos e fotos de uma vez, isso consome bastante memória.
No plano gratuito do Render (512 MB de RAM), tentar gerar o catálogo
**completo** (ex: quase 900 produtos) pode estourar a memória e derrubar o
serviço inteiro por alguns instantes (aparece como "502 Bad Gateway" pro
visitante, sem nenhuma mensagem clara).

Pra evitar isso, o servidor recusa gerar mais de `MAX_PRODUTOS_POR_GERACAO`
produtos de uma vez (200 por padrão — dá pra ajustar essa constante no topo
do `server.js`) e mostra uma mensagem pedindo pra filtrar por busca ou
categoria antes. Se seu catálogo tem centenas de produtos e você quer poder
gerar tudo de uma vez sem esse limite, o caminho é migrar pra um plano pago
do Render com mais RAM.

## Como os dados chegam no site

O site busca os produtos direto da mesma planilha do Google Sheets que o
Script Catálogo mantém (Tiny ERP + busca de imagem na web). Não precisa
copiar nada manualmente — assim que a planilha atualiza, o site atualiza
junto (o servidor guarda os dados em cache por 1 minuto só pra não
sobrecarregar a planilha a cada clique).

Se um dia precisar apontar para outra planilha, defina a variável de
ambiente `OPEN_SHEET_URL` (no Render: aba **Environment**) com o link no
formato `https://opensheet.elk.sh/ID_DA_PLANILHA/NomeDaAba`.

## Botão "Baixar catálogo em PDF"

Gera um PDF formatado (capa, produtos com foto, preço, código, banners) na
hora, já considerando o filtro de busca/categoria que estiver ativo na tela.
Pode demorar alguns segundos, pois ele baixa as fotos dos produtos para
montar o PDF.

## Botão "Ver como revista online"

Gera o mesmo PDF na hora e envia para o [Heyzine](https://heyzine.com), um
serviço pronto de catálogo digital, que transforma o PDF em uma revista
online com efeito de virar página bem realista (o mesmo tipo de efeito do
catalogo-goedert-group). O visitante é redirecionado direto para o link do
Heyzine, pronto para folhear ou compartilhar.

Para esse botão funcionar é preciso configurar a variável de ambiente
`HEYZINE_CLIENT_ID` com o **Client Id** da sua conta Heyzine — não confundir
com a "API key": os dois valores aparecem juntos em
[heyzine.com/developers](https://heyzine.com/developers) (logado na conta),
mas o endpoint que este site usa autentica especificamente com o Client Id.
No Render, adicione essa variável na aba **Environment** do seu serviço (o
`render.yaml` já reserva o nome da variável, mas por segurança o valor não
fica salvo no repositório — você precisa colar o Client Id lá).

Se a variável não estiver configurada, o botão mostra uma mensagem de erro
explicando o que falta, em vez de travar o site.

**Importante:** esse botão só funciona no site publicado (com link público),
porque o Heyzine precisa conseguir baixar o PDF gerado pela internet. Rodando
só em `localhost` no seu computador, o Heyzine não consegue alcançar o
arquivo e a geração falha — isso é esperado, não é erro. Depois de publicado
no Render (ou onde for), funciona normalmente.

## Pré-aquecimento automático (deixa os dois botões mais rápidos)

Assim que o servidor sobe, e depois a cada ~100 minutos, ele gera sozinho o
PDF e a revista digital do catálogo **completo** (sem nenhum filtro) e deixa
prontos no cache — é o caso mais comum, de longe. Assim, na maioria das
vezes, os dois botões respondem quase na hora, em vez do visitante ter que
esperar o Chrome gerar tudo do zero. Buscas com filtro (categoria, marca,
texto) continuam sendo geradas só quando alguém realmente pede — como têm
menos produtos, já são naturalmente mais rápidas.

Pra esse pré-aquecimento também valer para o botão "Ver como revista
online", defina a variável de ambiente `SITE_URL` com o link público do
site (ex.: `https://catalogo.vesco.com.br`) — é o mesmo motivo do aviso
acima: o Heyzine precisa de um link público pra baixar o PDF, e como esse
pré-aquecimento roda sozinho (sem visitante nenhum clicando em nada), não
tem como descobrir esse link sozinho. No Render isso já funciona automático
(ele expõe essa informação numa variável própria); em outras hospedagens
(Hostinger, etc.) defina `SITE_URL` manualmente nas variáveis de ambiente
do site. Sem essa variável, o PDF continua sendo pré-aquecido normalmente —
só a revista digital que fica de fora do pré-aquecimento (mas o botão
continua funcionando normalmente, só sem o ganho de velocidade).

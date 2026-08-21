// server.js — Catálogo Vesco: site + gerador de PDF com um clique
// Executar: npm install && npm start
'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const util = require('util');
const execFileAsync = util.promisify(require('child_process').execFile);
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');

const PORT = process.env.PORT || 3000;
const OPEN_SHEET_URL =
  process.env.OPEN_SHEET_URL ||
  'https://opensheet.elk.sh/1NreFb1kPT3BxnOwKyhr532oXsm7cmZCsHIoZ_X_JmHU/Pagina1';

// Credencial do Heyzine (heyzine.com) — usada só para transformar o PDF
// gerado num catálogo "revista digital" (efeito de página realista) com um
// link pra compartilhar. Pode trocar via variável de ambiente na hora do
// deploy (recomendado, em vez de deixar fixa aqui no código).
//
// Importante: o endpoint de conversão (/api1/rest) usado aqui autentica com
// o "Client Id" da conta (enviado como client_id no corpo da requisição),
// e NÃO com a "API key" (essa é usada só em outros endpoints de gestão do
// Heyzine, como detalhes/edição de flipbooks já criados). Os dois valores
// aparecem juntos na mesma página da conta: https://heyzine.com/developers
// (é preciso estar logado). Se aparecer erro de "invalid api key" ao gerar
// a revista, confirme que o valor abaixo é o Client Id, não a API key.
const HEYZINE_CLIENT_ID =
  process.env.HEYZINE_CLIENT_ID ||
  process.env.HEYZINE_API_KEY ||
  '0feeb11c5431caa2';
const TMP_DIR = path.join(__dirname, 'public', 'tmp');

// Link público do site (ex.: https://catalogo.vesco.com.br), usado só pelo
// pré-aquecimento automático do cache (ver preAquecerCacheCompleto mais
// abaixo) pra montar a URL do PDF que o Heyzine precisa baixar — nesse caso
// não existe uma requisição de visitante de onde tirar esse endereço, como
// acontece nas rotas normais. Opcional: sem essa variável, o pré-aquecimento
// da revista digital é só pulado (o PDF continua sendo pré-aquecido normal).
// No Render essa variável já vem pronta sozinha (RENDER_EXTERNAL_URL); em
// outras hospedagens (Hostinger, etc.) defina SITE_URL manualmente.
const SITE_URL = (process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

const ITEMS_PER_PAGE = 10;
const BANNER_EVERY_PAGES = 4;

// Gerar o catálogo inteiro (centenas de produtos, cada um com foto) de uma
// vez só, numa única página do Chrome headless, usa bastante memória — no
// plano gratuito do Render (512 MB de RAM) isso estourava a memória e
// derrubava o serviço inteiro ("502 Bad Gateway"/"Ran out of memory", sem
// mensagem de erro clara). Por isso, catálogos grandes agora são gerados em
// LOTES pequenos (ver LOTE_PAGINAS_PDF mais abaixo): cada lote abre e fecha
// o PROCESSO INTEIRO do Chrome (não só a página) antes do lote seguinte
// começar — fechar só a página não bastou, porque o Chrome não devolve toda
// a memória pro sistema operacional enquanto o processo continua de pé.
// Fechando o processo inteiro a cada lote, o sistema operacional recupera
// essa memória de verdade antes do próximo lote começar. Todos os PDFs
// parciais são unidos no final. MAX_PRODUTOS_POR_GERACAO continua existindo
// só como um teto de segurança bem folgado, caso o catálogo cresça demais
// no futuro.
const MAX_PRODUTOS_POR_GERACAO = 2000;

// Quantas "páginas" (cada uma com até ITEMS_PER_PAGE produtos) entram em
// cada lote/PDF parcial. 8 páginas × 10 produtos = até 80 produtos com foto
// carregados de uma vez no Chrome — bem mais conservador que o limite
// antigo de geração única (200), porque mesmo o esquema em lotes anterior
// (150 por lote, reaproveitando o mesmo Chrome aberto) ainda estourou a
// memória do plano gratuito do Render.
const LOTE_PAGINAS_PDF = 8;

// Cache em memória do PDF/revista já gerados, por combinação de filtros
// (busca + categoria + marca). É o que faz o botão ficar rápido depois da
// primeira vez — gerar o PDF com o Chrome headless é sempre a parte lenta
// (ainda mais no plano gratuito do Render, com CPU compartilhada e o site
// "dormindo" depois de 15 min sem uso), então evitamos repetir esse trabalho
// pra cada clique. Some da memória se o servidor reiniciar, e é gerado de
// novo automaticamente na próxima vez — sem precisar de nenhum banco de
// dados nem configuração extra.
const PDF_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas
const cachePdf = new Map(); // chave -> { buffer, geradoEm }
const cacheFlipbook = new Map(); // chave -> { url, geradoEm }

function chaveCache(req) {
  const busca = String(req.query.busca || '').trim().toLowerCase();
  const categoria = String(req.query.categoria || '').trim().toLowerCase();
  const marca = String(req.query.marca || '').trim().toLowerCase();
  return `${busca}|${categoria}|${marca}`;
}

// Chave de cache do catálogo "sem filtro nenhum" (todos os produtos) — é a
// combinação usada pelo pré-aquecimento automático (preAquecerCacheCompleto,
// mais abaixo) e é também a chave que uma visita ao site sem nenhuma busca
// ativa vai bater automaticamente.
const CHAVE_CACHE_TUDO = chaveCache({ query: {} });

// placeholder "sem imagem" em SVG (não depende de arquivo externo)
const SEM_IMAGEM_DATA_URL =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
      <rect width="200" height="200" fill="#f1f5f9"/>
      <g fill="#94a3b8" font-family="Arial, sans-serif" text-anchor="middle">
        <circle cx="100" cy="80" r="28" fill="none" stroke="#cbd5e1" stroke-width="4"/>
        <line x1="70" y1="120" x2="130" y2="60" stroke="#cbd5e1" stroke-width="4"/>
        <text x="100" y="160" font-size="14">sem imagem</text>
      </g>
    </svg>`
  ).toString('base64');

const app = express();
// Importante para quando isso roda atrás de um proxy reverso (Easypanel,
// Render, etc.), que normalmente termina o HTTPS e repassa a requisição
// pro container por HTTP simples: sem isso, req.protocol sempre voltaria
// "http", e a URL pública montada pro PDF (usada pelo Heyzine) ficaria
// errada mesmo com o site publicado em HTTPS.
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '256kb' })); // usado só pelo /gerar-pdf-carrinho (POST com a lista de itens)
// "no-store" nos arquivos do site (HTML/CSS/JS) — sem isso, o navegador de
// quem já visitou o site guarda o main.js/style.css antigo em cache e
// continua usando ele por conta própria em visitas seguintes, mesmo depois
// de uma atualização já estar publicada de verdade no servidor (foi
// exatamente esse o motivo do botão "+" do carrinho não aparecer depois de
// publicar o v27: o servidor já estava certo, mas o navegador insistia no
// main.js de antes). Como esse catálogo é atualizado com frequência e não
// é um site de tráfego gigante, vale mais a pena garantir "sempre a versão
// certa" do que economizar uns poucos KB de banda por visita.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
  })
);

// ---------------------------------------------------------------
// Cache simples em memória para não bater na planilha a cada request
// ---------------------------------------------------------------
let produtosCache = { data: null, at: 0 };
const CACHE_TTL_MS = 60 * 1000;

async function buscarProdutos() {
  const agora = Date.now();
  if (produtosCache.data && agora - produtosCache.at < CACHE_TTL_MS) {
    return produtosCache.data;
  }
  const resp = await fetch(OPEN_SHEET_URL);
  if (!resp.ok) throw new Error('Erro ao buscar planilha: HTTP ' + resp.status);
  const bruto = await resp.json();

  const produtos = (bruto || [])
    .map((p) => normalizarProduto(p))
    .filter((p) => p.produto); // ignora linhas sem nome

  produtosCache = { data: produtos, at: agora };
  return produtos;
}

// ---------------------------------------------------------------
// Categorização automática: em vez de depender da coluna "categoria"
// da planilha (que vem vazia ou inconsistente boa parte das vezes), a
// categoria de cada produto é detectada a partir de palavras-chave no
// próprio nome — assim fica simples de ajustar (só mexer na lista
// abaixo) e sempre consistente entre o site, o PDF e a revista digital
// (os três usam esse mesmo campo "categoria", vindo do /api/produtos).
//
// A ordem importa: a primeira regra que bater com o nome do produto
// "ganha", então termos mais específicos (ex.: "interfolha") vêm antes
// de termos mais genéricos (ex.: "toalha"). Pra ajustar/adicionar uma
// categoria nova, basta acrescentar uma linha na lista abaixo.
const REGRAS_CATEGORIA = [
  // Equipamentos/acessórios primeiro: um "dispenser para papel toalha"
  // é um dispenser, não um papel toalha — por isso essa regra precisa
  // vir antes das categorias de papel abaixo.
  ['Dispensers e Suportes', /dispenser|suporte para|porta[- ]?papel/],
  ['Papel Higiênico', /higien/],
  ['Papel Toalha Interfolha', /interfolha/],
  ['Papel Toalha Bobina', /\bbobina/],
  ['Papel Toalha', /toalha/],
  ['Lenços de Papel', /\blenc[oa]s? de papel\b|kleenex|folha tripla|folha dupla|lenco umedecido/],
  ['Lençol Hospitalar', /lencol hospitalar|lencol descartavel/],
  ['Guardanapo', /guardanapo/],
  ['Sabonete', /sabonete|sabao liquido|sabao em barra|sabao em pedra/],
  // "Desincrustante" precisa vir antes de "Desinfetante" — são produtos
  // diferentes (um remove incrustação/resíduo, outro desinfeta), mas
  // "desincrustante" nunca vai bater com o regex de "desinfetante" mesmo
  // assim, então a ordem aqui é só por organização.
  ['Desincrustante', /desincrustante|anti[- ]?incrustante|removedor de incrustac/],
  ['Desinfetante', /desinfetante/],
  ['Álcool', /\balcool\b/],
  ['Água Sanitária', /agua sanitaria|\bcloro\b|hipoclorito/],
  ['Detergente', /detergente|sabao em po|lava roupa|lava-roupa/],
  ['Amaciante', /amaciante/],
  // "Ceras" precisa vir antes de "Removedores" — um "removedor de ceras
  // acrílicas" é sobre cera, não um removedor genérico qualquer.
  ['Ceras e Impermeabilizantes', /\bceras?\b|acabamento acrilico|impermeabilizante|selador/],
  ['Removedores', /\bremovedor(es)?\b/],
  ['Baldes', /\bbalde/],
  ['Cabos e Hastes', /\bcabo(s)?\b|\bhaste(s)?\b/],
  ['Mops e Refis', /\bmop\b|refil.*mop/],
  ['Sacos de Lixo', /saco.*lixo|lixo.*saco/],
  ['Copos Descartáveis', /copo descart/],
  ['Luvas', /\bluva/],
  ['Máscaras e EPI', /mascara|\bepi\b|touca descartavel|protetor facial/],
  ['Vassouras e Rodos', /vassoura|\brodo\b|pa de lixo/],
  ['Esponjas e Buchas', /esponja|bucha/],
  ['Panos e Flanelas', /pano de chao|pano de piso|flanela|microfibra/],
  // "Multiuso" fica por último entre os produtos de limpeza porque
  // costuma aparecer como adjetivo em cima de outra categoria (ex.:
  // "esponja multiuso"), não como o tipo do produto em si.
  ['Multiuso', /multiuso|multi uso|multi-uso/]
];

function normalizarTextoCategoria(txt) {
  return String(txt || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function categorizarProduto(nomeProduto) {
  const texto = normalizarTextoCategoria(nomeProduto);
  const regra = REGRAS_CATEGORIA.find(([, regex]) => regex.test(texto));
  return regra ? regra[0] : '';
}

// Quando nenhuma regra de palavra-chave bate com o nome do produto, em vez
// de usar a categoria "crua" da planilha (que às vezes vem como um caminho
// enorme tipo "Casa, Móveis e Decoração >> Cuidado da Casa e Lavanderia >>
// Produtos de Limpeza >> Água Sanitária" — poluindo o filtro do site com
// opções gigantes e repetitivas), pega só o ÚLTIMO pedaço desse caminho
// (o mais específico) como categoria — no exemplo acima, viraria só "Água
// Sanitária". Fica simples de qualquer jeito, mesmo sem bater em nenhuma
// palavra-chave configurada manualmente.
function categoriaSimplesDoCaminho(bruta) {
  if (!bruta) return '';
  const partes = String(bruta)
    .split('>>')
    .map((s) => s.trim())
    .filter(Boolean);
  return partes.length ? partes[partes.length - 1] : '';
}

// Marcação manual de "mais vendido": lê a coluna "destaque" da planilha
// (crie essa coluna e escreva "sim" nas linhas dos produtos que quer
// destacar — deixe em branco nas demais). Aceita algumas variações comuns
// de como alguém digitaria "sim" numa planilha, pra não depender de
// escrever exatamente igual toda vez.
const VALORES_SIM = ['sim', 's', 'true', 'verdadeiro', '1', 'x', 'yes'];
function ehSimNao(valor) {
  return VALORES_SIM.includes(normalizarTextoCategoria(valor).trim());
}

function normalizarProduto(p) {
  const imagemBruta = (p.imagem || '').trim();
  const imagemValida = imagemBruta.startsWith('http') ? imagemBruta : '';
  const nome = p.produto || '';
  return {
    codigo: p.codigo || '',
    produto: nome,
    marca: p.marca || '',
    categoria: categorizarProduto(nome) || categoriaSimplesDoCaminho(p.categoria) || 'Outros',
    custo: p.custo || '',
    venda: p.venda || '',
    imagem: imagemValida,
    gtin: p.gtin || '',
    id: p.id || '',
    destaque: ehSimNao(p.destaque)
  };
}

function formatarPreco(v) {
  if (v === undefined || v === null || v === '' || Number(String(v).replace(',', '.')) === 0) {
    return 'Consulte';
  }
  const num = Number(String(v).replace(',', '.').replace(/[^\d.-]/g, ''));
  if (Number.isNaN(num)) return `R$ ${v}`;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Mesma lógica do "precoNumerico" do main.js (preço 0/vazio/inválido vira
// "null", pra tratar como "Consulte" em vez de contar como R$0 na soma do
// carrinho) — reimplementada aqui porque o servidor não carrega main.js.
function precoNumericoServidor(venda) {
  const num = Number(String(venda || '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

// ---------------------------------------------------------------
// API: lista de produtos (usada pelo site — mesma origem, sem CORS)
// ---------------------------------------------------------------
app.get('/api/produtos', async (req, res) => {
  try {
    const produtos = await buscarProdutos();
    res.json(produtos);
  } catch (err) {
    console.error('Erro /api/produtos:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.send('ok'));

// Rota de diagnóstico do Chrome/Puppeteer — útil quando o botão de PDF/
// revista digital dá erro numa hospedagem onde não dá pra ver os logs de
// execução direto (ou pra confirmar rapidinho se a instalação automática
// funcionou). Só mostra informação técnica sobre o Chrome, nada sensível.
app.get('/debug-chrome', async (req, res) => {
  let executablePathEsperado;
  try {
    executablePathEsperado = puppeteer.executablePath();
  } catch (erro) {
    executablePathEsperado = 'erro ao calcular: ' + erro.message;
  }

  const info = {
    plataforma: process.platform,
    versaoNode: process.version,
    execPathNode: process.execPath,
    npxCalculado: caminhoDoNpx(),
    npxCalculadoExiste: fsSync.existsSync(caminhoDoNpx()),
    cliPuppeteerCalculado: caminhoCliPuppeteer(),
    executablePathEsperado,
    chromeJaInstaladoAntes: chromeJaInstalado()
  };

  if (!info.chromeJaInstaladoAntes) {
    try {
      await garantirChromeInstalado();
      info.resultadoTentativaAgora = chromeJaInstalado()
        ? 'Chrome instalado com sucesso agora.'
        : 'A tentativa rodou mas o Chrome ainda não foi encontrado depois.';
      info.erroDaTentativa = ultimoErroInstalacaoChrome;
    } catch (erro) {
      info.resultadoTentativaAgora = 'Erro: ' + erro.message;
    }
  }

  res.json(info);
});

// ---------------------------------------------------------------
// Geração do PDF
// ---------------------------------------------------------------
// Observação: as fotos NÃO são baixadas e convertidas em base64 aqui no
// Node — isso foi tentado antes, mas com centenas de produtos (o catálogo
// tem ~760) o HTML final ficava com dezenas de MB de texto embutido, e o
// Chromium travava/derrubava a aba na hora de gerar o PDF ("Target closed",
// "Protocol error"). Em vez disso, passamos a URL da imagem direto pro
// <img src>, e é o próprio Chromium (headless) que baixa e desenha cada
// foto — do mesmo jeito que um navegador normal faria, de forma bem mais
// leve em memória. `onerror` no HTML cobre fotos com link quebrado.
// Frases da página de destaque que aparece entre os produtos no PDF —
// uma diferente a cada vez que ela aparece, pra prender mais a atenção
// de quem está folheando (a mesma lista usada no site).
const FRASES_DESTAQUE = [
  { titulo: 'Higiene que sua empresa pode confiar', texto: 'Produtos de alta performance para manter seu espaço impecável, todos os dias.' },
  { titulo: 'Mais limpeza, menos preocupação', texto: 'Ótimo rendimento e performance profissional — a escolha certa pra quem quer economia sem abrir mão da qualidade.' },
  { titulo: 'Seleção Vesco', texto: 'Os produtos mais procurados do nosso catálogo, com a qualidade que só quem entende de higiene profissional entrega.' },
  { titulo: 'A primeira impressão começa na limpeza', texto: 'Eleve o padrão do seu espaço com produtos que unem qualidade, cuidado e performance em cada detalhe.' },
  { titulo: 'Seu negócio limpo, sua reputação em dia', texto: 'Soluções completas em higiene pra você cuidar do que importa, com a tranquilidade de ter o produto certo em mãos.' },
  { titulo: 'Praticidade que rende de verdade', texto: 'Produtos pensados pro dia a dia da sua operação — menos reposição, mais resultado.' },
  { titulo: 'Feito pra quem exige o melhor', texto: 'Fornecedores de confiança, produtos testados e aprovados por quem vive a rotina da limpeza profissional.' },
  { titulo: 'Limpeza que também é cuidado', texto: 'Cada produto Vesco carrega o compromisso de proteger pessoas e espaços com qualidade de verdade.' }
];

function montarPaginas(produtos) {
  const paginasProdutos = [];
  for (let i = 0; i < produtos.length; i += ITEMS_PER_PAGE) {
    paginasProdutos.push(produtos.slice(i, i + ITEMS_PER_PAGE));
  }
  const paginas = [];
  let contadorDestaque = 0;
  for (let i = 0; i < paginasProdutos.length; i++) {
    paginas.push({ type: 'produtos', items: paginasProdutos[i] });
    if ((i + 1) % BANNER_EVERY_PAGES === 0 && i !== paginasProdutos.length - 1) {
      paginas.push({ type: 'banner', bannerIndex: contadorDestaque });
      contadorDestaque += 1;
    }
  }
  return paginas;
}

// `paginas` é só o pedaço (lote) que vai virar HTML dessa vez — pode ser o
// catálogo inteiro (geração simples) ou só uma fatia dele (geração em
// lotes). `incluirCapa` liga a capa só no primeiro lote, e `numeroInicial`
// continua a numeração das páginas de onde o lote anterior parou.
function gerarHTML(paginas, totalProdutos, opts = {}) {
  const { incluirCapa = true, numeroInicial = 2 } = opts;
  const dataGeracao = new Date().toLocaleDateString('pt-BR');

  const capa = !incluirCapa ? '' : `
    <section class="pagina capa">
      <div class="capa-conteudo">
        <div class="capa-marca">VESCO</div>
        <h1>Catálogo de Produtos</h1>
        <p>Soluções em Higiene e Limpeza</p>
        <div class="capa-meta">${totalProdutos} produtos · gerado em ${dataGeracao}</div>
      </div>
    </section>`;

  const paginasHtml = paginas
    .map((pagina, idx) => {
      const numero = numeroInicial + idx;
      if (pagina.type === 'banner') {
        const frase = FRASES_DESTAQUE[(pagina.bannerIndex || 0) % FRASES_DESTAQUE.length];
        return `
        <section class="pagina">
          ${cabecalho(numero)}
          <div class="banner">
            <h2>${escapeHtml(frase.titulo)}</h2>
            <p>${escapeHtml(frase.texto)}</p>
          </div>
          ${rodape()}
        </section>`;
      }
      return `
      <section class="pagina">
        ${cabecalho(numero)}
        <div class="grade">
          ${pagina.items
            .map(
              (p) => `
            <article class="produto">
              <div class="produto-img"><img src="${p.img || SEM_IMAGEM_DATA_URL}" alt="${escapeHtml(p.produto)}" onerror="this.onerror=null;this.src='${SEM_IMAGEM_DATA_URL}';"/></div>
              <div class="produto-info">
                <div class="produto-marca">${escapeHtml(p.marca || 'Vesco')}</div>
                <div class="produto-nome">${escapeHtml(p.produto)}</div>
                <div class="produto-cod">Cód: ${escapeHtml(p.codigo || '—')}</div>
                <div class="produto-preco">${formatarPreco(p.venda)}</div>
              </div>
            </article>`
            )
            .join('')}
        </div>
        ${rodape()}
      </section>`;
    })
    .join('');

  function cabecalho(numero) {
    return `
      <header class="cabecalho">
        <div class="cabecalho-marca">VESCO</div>
        <div class="cabecalho-pagina">${numero}</div>
      </header>`;
  }
  function rodape() {
    return `<footer class="rodape">Catálogo Vesco — Soluções em Higiene e Limpeza</footer>`;
  }

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>Catálogo Vesco</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; font-family: 'Segoe UI', Arial, sans-serif; color:#0f2a3d; }
  .pagina {
    width: 210mm; height: 297mm; padding: 14mm 14mm 10mm;
    page-break-after: always; display:flex; flex-direction:column;
  }
  .capa { background: linear-gradient(160deg, #00334d, #01547d); color:#fff; align-items:center; justify-content:center; text-align:center; }
  .capa-conteudo { max-width: 500px; }
  .capa-marca { letter-spacing: 6px; font-weight:800; font-size: 16px; opacity:.85; margin-bottom: 18px; }
  .capa h1 { font-size: 38px; margin: 0 0 10px; }
  .capa p { font-size: 16px; opacity:.85; margin: 0 0 30px; }
  .capa-meta { font-size: 12px; opacity:.65; border-top: 1px solid rgba(255,255,255,.3); padding-top: 12px; }
  .cabecalho { display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #00334d; padding-bottom:8px; margin-bottom:14px; }
  .cabecalho-marca { font-weight:800; letter-spacing:3px; color:#00334d; font-size:14px; }
  .cabecalho-pagina { font-weight:700; color:#00a859; font-size:13px; }
  .grade { flex:1; display:grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(5, 1fr); gap:10px; }
  .produto { display:flex; flex-direction:row; align-items:center; text-align:left; gap:10px; border:1px solid #e6ecf0; border-radius:10px; padding:8px; height:100%; box-shadow:0 2px 8px rgba(0,51,77,.05); }
  .produto-img { width:38%; max-width:90px; height:90%; display:flex; align-items:center; justify-content:center; background:#f8fafb; border:1px solid #e6ecf0; border-radius:8px; overflow:hidden; flex:0 0 auto; }
  .produto-img img { max-width:100%; max-height:100%; object-fit:contain; }
  .produto-info { min-width:0; display:flex; flex-direction:column; align-items:flex-start; }
  .produto-marca { color:#00a859; font-weight:800; font-size:8.5px; text-transform:uppercase; letter-spacing:.5px; }
  .produto-nome { font-weight:700; font-size:11px; line-height:1.2; margin:3px 0; color:#0f2a3d; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .produto-cod { font-size:8.5px; color:#6b7c85; }
  .produto-preco { display:inline-block; margin-top:4px; padding:2px 10px; border-radius:999px; background:rgba(0,168,89,.12); color:#00753d; font-weight:800; font-size:11.5px; }
  .banner { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; background: linear-gradient(160deg, #eef7f2, #dff2e7); border-radius:16px; }
  .banner h2 { color:#00334d; font-size:26px; margin:0 0 8px; }
  .banner p { color:#37525f; font-size:14px; margin:0; }
  .rodape { text-align:center; font-size:9px; color:#8fa1a8; margin-top:10px; padding-top:8px; border-top:1px solid #eef1f2; }
</style>
</head>
<body>
${capa}
${paginasHtml}
</body>
</html>`;
}

// Monta o HTML do PDF do CARRINHO — diferente do catálogo normal (grade
// de fotos), aqui é uma lista/tabela com quantidade e subtotal de cada
// item, e um total geral no final, do jeito que um orçamento de verdade
// costuma ser. Reaproveita as mesmas cores/fontes do catálogo pra manter
// a identidade visual, mas o layout em si é próprio.
const ITENS_CARRINHO_POR_PAGINA = 14;

function gerarHTMLCarrinho(itens) {
  const dataGeracao = new Date().toLocaleDateString('pt-BR');
  const total = itens.reduce((soma, it) => soma + (it.subtotal || 0), 0);
  const temItemSemPreco = itens.some((it) => it.subtotal === null);

  const paginasItens = [];
  for (let i = 0; i < itens.length; i += ITENS_CARRINHO_POR_PAGINA) {
    paginasItens.push(itens.slice(i, i + ITENS_CARRINHO_POR_PAGINA));
  }
  if (paginasItens.length === 0) paginasItens.push([]);

  const paginasHtml = paginasItens
    .map((pagina, idx) => {
      const ehUltima = idx === paginasItens.length - 1;
      const linhas = pagina
        .map(
          (it) => `
        <tr>
          <td class="col-produto">
            <div class="linha-produto">
              <img src="${it.produto.imagem || SEM_IMAGEM_DATA_URL}" onerror="this.onerror=null;this.src='${SEM_IMAGEM_DATA_URL}';"/>
              <div>
                <div class="linha-nome">${escapeHtml(it.produto.produto)}</div>
                <div class="linha-cod">Cód: ${escapeHtml(it.produto.codigo || '—')} · ${escapeHtml(it.produto.marca || 'Vesco')}</div>
              </div>
            </div>
          </td>
          <td class="col-preco">${formatarPreco(it.produto.venda)}</td>
          <td class="col-qtd">${it.quantidade}</td>
          <td class="col-subtotal">${it.subtotal === null ? 'Consulte' : formatarPreco(it.subtotal)}</td>
        </tr>`
        )
        .join('');

      return `
      <section class="pagina">
        <header class="cabecalho">
          <div class="cabecalho-marca">VESCO — ORÇAMENTO</div>
          <div class="cabecalho-pagina">${idx + 1}/${paginasItens.length}</div>
        </header>
        <table class="tabela-carrinho">
          <thead>
            <tr><th class="col-produto">Produto</th><th class="col-preco">Preço unit.</th><th class="col-qtd">Qtd.</th><th class="col-subtotal">Subtotal</th></tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>
        ${ehUltima ? `
        <div class="total-geral">
          <span>Total geral</span>
          <strong>${formatarPreco(total)}</strong>
        </div>
        ${temItemSemPreco ? '<p class="aviso-consulte">* itens marcados "Consulte" não entram na soma do total — fale com a gente pelo WhatsApp pra confirmar o preço.</p>' : ''}
        ` : ''}
        <footer class="rodape">Catálogo Vesco — Soluções em Higiene e Limpeza · Orçamento gerado em ${dataGeracao}</footer>
      </section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>Orçamento Vesco</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; font-family: 'Segoe UI', Arial, sans-serif; color:#0f2a3d; }
  .pagina { width: 210mm; height: 297mm; padding: 14mm; page-break-after: always; display:flex; flex-direction:column; }
  .cabecalho { display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #00334d; padding-bottom:8px; margin-bottom:16px; }
  .cabecalho-marca { font-weight:800; letter-spacing:2px; color:#00334d; font-size:14px; }
  .cabecalho-pagina { font-weight:700; color:#00a859; font-size:13px; }
  .tabela-carrinho { width:100%; border-collapse: collapse; }
  .tabela-carrinho th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:#6b7c85; padding:6px 8px; border-bottom:2px solid #e6ecf0; }
  .tabela-carrinho td { padding:8px; border-bottom:1px solid #eef1f2; vertical-align:middle; font-size:12px; }
  .col-preco, .col-qtd, .col-subtotal { text-align:right; white-space:nowrap; }
  .col-qtd { text-align:center; }
  .col-subtotal { font-weight:800; color:#00753d; }
  .linha-produto { display:flex; align-items:center; gap:10px; }
  .linha-produto img { width:40px; height:40px; object-fit:contain; border-radius:6px; background:#f8fafb; border:1px solid #e6ecf0; flex:0 0 auto; }
  .linha-nome { font-weight:700; font-size:12px; }
  .linha-cod { font-size:9.5px; color:#6b7c85; margin-top:2px; }
  .total-geral { margin-top:18px; padding-top:14px; border-top:2px solid #00334d; display:flex; justify-content:space-between; align-items:baseline; }
  .total-geral span { font-size:14px; font-weight:700; }
  .total-geral strong { font-size:22px; color:#00334d; }
  .aviso-consulte { font-size:10px; color:#6b7c85; margin-top:8px; }
  .rodape { margin-top:auto; text-align:center; font-size:9px; color:#8fa1a8; padding-top:8px; border-top:1px solid #eef1f2; }
</style>
</head>
<body>
${paginasHtml}
</body>
</html>`;
}

// Recebe {codigo, quantidade} vindos do carrinho do navegador, confere
// cada produto direto na planilha (nunca confia no nome/preço que o
// navegador mandou — só no código) e gera o PDF do orçamento.
async function gerarPdfCarrinho(itensCarrinho) {
  const todos = await buscarProdutos();
  const porCodigo = new Map(todos.map((p) => [String(p.codigo), p]));

  const itens = itensCarrinho
    .map((it) => {
      const produto = porCodigo.get(String(it && it.codigo));
      if (!produto) return null;
      const quantidade = Math.max(1, Math.min(9999, Math.round(Number(it.quantidade) || 1)));
      const precoUnit = precoNumericoServidor(produto.venda);
      const subtotal = precoUnit === null ? null : precoUnit * quantidade;
      return { produto, quantidade, subtotal };
    })
    .filter(Boolean);

  if (itens.length === 0) {
    throw new Error('Nenhum dos produtos do carrinho foi encontrado no catálogo atual.');
  }

  const html = gerarHTMLCarrinho(itens);
  await fs.mkdir(TMP_DIR, { recursive: true });
  const nomeArquivo = `carrinho-${crypto.randomBytes(8).toString('hex')}.pdf`;
  const caminho = path.join(TMP_DIR, nomeArquivo);
  try {
    await renderizarLoteParaArquivo(html, caminho);
    return await fs.readFile(caminho);
  } finally {
    fs.unlink(caminho).catch(() => {});
  }
}

async function filtrarProdutos(req) {
  const busca = String(req.query.busca || '').trim().toLowerCase();
  const categoria = String(req.query.categoria || '').trim().toLowerCase();
  const marca = String(req.query.marca || '').trim().toLowerCase();

  let produtos = await buscarProdutos();

  if (busca) {
    produtos = produtos.filter((p) =>
      `${p.produto} ${p.marca} ${p.codigo}`.toLowerCase().includes(busca)
    );
  }
  if (categoria) {
    produtos = produtos.filter((p) => (p.categoria || '').toLowerCase() === categoria);
  }
  if (marca) {
    produtos = produtos.filter((p) => (p.marca || '').toLowerCase() === marca);
  }
  produtos.sort((a, b) => a.produto.localeCompare(b.produto, 'pt-BR'));
  return produtos;
}

// Flags do Chrome headless pensadas pra usar o mínimo de memória possível —
// desligam várias coisas que o Chrome normalmente carrega sozinho (contas
// em segundo plano, extensões, telemetria, etc.) e que não servem pra nada
// aqui, já que só usamos ele pra transformar HTML em PDF.
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-features=TranslateUI,BlinkGenPropertyTrees',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run'
];

// Algumas hospedagens compartilhadas (Hostinger/hPanel entre elas) bloqueiam
// o script "postinstall" do package.json por segurança — nesse caso o Chrome
// que o Puppeteer precisa pra gerar PDF nunca chega a ser baixado durante o
// deploy, e os botões de PDF/revista digital falham com "Could not find
// Chrome". Em vez de depender só do postinstall, o servidor confere sozinho
// se o Chrome existe assim que sobe (e de novo, como segurança extra, antes
// de cada geração) — se não existir, baixa ele mesmo aqui, sem precisar de
// terminal/SSH nenhum no painel da hospedagem.
function chromeJaInstalado() {
  try {
    return fsSync.existsSync(puppeteer.executablePath());
  } catch {
    return false;
  }
}

// Em algumas hospedagens (Hostinger/hPanel entre elas), o processo Node da
// aplicação roda com um PATH mais "enxuto" do que o de um terminal normal —
// suficiente pra achar o "node", mas não necessariamente o "npx" (eles nem
// sempre moram na mesma pasta que o sistema aponta por padrão). Isso fazia
// o "npx" simplesmente não ser encontrado (erro "ENOENT") e a instalação
// automática do Chrome falhar silenciosamente. Em vez de confiar no PATH,
// calculamos o caminho do "npx" a partir do caminho exato do "node" que já
// está rodando este servidor agora (eles sempre ficam lado a lado, na mesma
// pasta) — muito mais confiável do que torcer pro PATH estar certo.
function caminhoDoNpx() {
  const candidato = path.join(path.dirname(process.execPath), 'npx');
  return fsSync.existsSync(candidato) ? candidato : 'npx';
}

// A causa REAL do problema na Hostinger (confirmada via /debug-chrome):
// "Permission denied" ao tentar rodar o atalho node_modules/.bin/puppeteer
// — o upload de arquivos da Hostinger não preserva a permissão de
// "executável" desse arquivinho (comum em hospedagens que sincronizam
// arquivos por FTP/painel em vez de git puro). O "npx puppeteer ..." por
// baixo dos panos tenta executar exatamente esse atalho, por isso falhava
// mesmo com o npx encontrado certinho. A saída: rodar o script de verdade
// do puppeteer diretamente com "node arquivo.js" (só precisa de permissão
// de LEITURA, que esses arquivos sempre têm) em vez de tentar EXECUTAR o
// atalho. Descobrimos o caminho desse script pelo próprio "bin" declarado
// no package.json do puppeteer, então continua funcionando mesmo se essa
// estrutura interna mudar de versão pra versão.
function caminhoCliPuppeteer() {
  try {
    const pkgPath = require.resolve('puppeteer/package.json');
    const pkg = require(pkgPath);
    const binRelativo = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.puppeteer;
    if (!binRelativo) return null;
    const caminho = path.join(path.dirname(pkgPath), binRelativo);
    return fsSync.existsSync(caminho) ? caminho : null;
  } catch {
    return null;
  }
}

// Guarda o erro mais recente da instalação automática (se der errado) —
// além de ir pro log do servidor, a rota /debug-chrome devolve esse texto
// direto na resposta, porque em hospedagens sem acesso fácil aos logs de
// execução (como vem sendo o caso na Hostinger) essa é a única forma de
// ver o motivo real sem precisar de terminal/SSH.
let ultimoErroInstalacaoChrome = null;

let promessaChromeInstalado = null;
function garantirChromeInstalado() {
  if (chromeJaInstalado()) return Promise.resolve();
  if (!promessaChromeInstalado) {
    promessaChromeInstalado = (async () => {
      try {
        console.log('Chrome do Puppeteer não encontrado — baixando automaticamente (pode levar 1 minuto)...');
        const cliPuppeteer = caminhoCliPuppeteer();
        if (cliPuppeteer) {
          // Caminho preferido: roda o script do puppeteer direto com "node",
          // sem depender de permissão de EXECUÇÃO em nenhum atalho — é o que
          // contorna o "Permission denied" visto na Hostinger.
          await execFileAsync(process.execPath, [cliPuppeteer, 'browsers', 'install', 'chrome'], {
            cwd: __dirname,
            maxBuffer: 1024 * 1024 * 20,
            timeout: 120000
          });
        } else {
          // Não achamos o script do puppeteer (estrutura de pastas
          // inesperada) — cai pro jeito antigo via "npx" como último recurso.
          await execFileAsync(caminhoDoNpx(), ['puppeteer', 'browsers', 'install', 'chrome'], {
            cwd: __dirname,
            maxBuffer: 1024 * 1024 * 20,
            timeout: 120000
          });
        }
        console.log('Chrome baixado com sucesso.');
        ultimoErroInstalacaoChrome = null;
      } catch (erro) {
        // Loga o máximo de detalhe possível (código do erro, ex.: "ENOENT"
        // quando o comando nem foi encontrado; "ETIMEDOUT"/"ECONNREFUSED"
        // quando é a rede que está bloqueando o download) — como não temos
        // acesso direto aos logs de execução da hospedagem, essa mensagem é
        // a única pista disponível se isso continuar falhando.
        ultimoErroInstalacaoChrome =
          (erro.code ? '[' + erro.code + '] ' : '') +
          erro.message +
          (erro.stderr ? ' | stderr: ' + String(erro.stderr).slice(0, 500) : '');
        console.error('Não foi possível baixar o Chrome automaticamente:', ultimoErroInstalacaoChrome);
      } finally {
        // Libera a "trava": se ainda faltar, a próxima geração tenta de novo
        // (em vez de ficar presa num erro antigo pra sempre).
        promessaChromeInstalado = null;
      }
    })();
  }
  return promessaChromeInstalado;
}

// Camada extra de segurança em cima do "garantirChromeInstalado": mesmo que
// a checagem tenha dito que o Chrome existe, tenta abrir e, se ainda assim
// vier o erro específico de "Could not find Chrome", força uma reinstalação
// e tenta abrir de novo (só essa uma vez, pra não entrar em loop).
async function lancarChromeComAutoInstalacao(opcoes) {
  try {
    return await puppeteer.launch(opcoes);
  } catch (erro) {
    if (String(erro.message || '').includes('Could not find Chrome')) {
      console.warn('Chrome sumiu/não instalado — tentando reinstalar antes de desistir...');
      promessaChromeInstalado = null;
      await garantirChromeInstalado();
      return await puppeteer.launch(opcoes);
    }
    throw erro;
  }
}

// Abre um Chrome novinho, renderiza um único lote (HTML já pronto, com até
// LOTE_PAGINAS_PDF páginas) em PDF, salva o resultado direto num arquivo em
// disco, e fecha o Chrome — o PROCESSO INTEIRO, não só a aba. É esse fechar
// o processo inteiro (em vez de só a página) que garante que o sistema
// operacional recupera de verdade a memória usada pelas fotos desse lote
// antes do lote seguinte começar a carregar as dele.
async function renderizarLoteParaArquivo(html, caminhoDestino) {
  await garantirChromeInstalado();
  let browser;
  try {
    browser = await lancarChromeComAutoInstalacao({
      headless: true,
      // O Puppeteer, por padrão, só espera 30s o Chrome terminar de abrir
      // (timeout do launch em si — diferente do protocolTimeout abaixo, que
      // é sobre comandos DEPOIS de já estar aberto). No plano gratuito do
      // Render, com CPU compartilhada e lenta, abrir o Chrome do zero a
      // CADA lote (como fazemos agora, de propósito, pra liberar memória
      // entre um lote e outro) às vezes passa desses 30s — foi exatamente
      // o erro "Timed out after waiting 30000ms" que apareceu na revista
      // digital. Por isso damos uma folga bem maior aqui.
      timeout: 90000,
      protocolTimeout: 120000,
      args: CHROME_ARGS
    });
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.warn('Aviso: erro na página do PDF (ignorado):', err.message));

    // Só espera o HTML/CSS carregar aqui (rápido, não depende de rede
    // externa) — NÃO usamos "networkidle0" porque, com dezenas de fotos
    // (URLs externas) carregando ao mesmo tempo, basta UMA foto lenta ou
    // travada pra isso nunca "ficar ocioso" e estourar o timeout inteiro
    // (foi exatamente o que causou o "Navigation timeout exceeded" com o
    // catálogo completo, antes de existir a geração em lotes). O timeout
    // aqui é generoso (60s) porque no plano gratuito do Render a CPU é
    // compartilhada e o site "dorme" depois de 15 min sem uso — a primeira
    // geração depois de um tempo parado pode ser bem mais lenta que o
    // normal só pra ligar o Chrome headless.
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Em vez disso, esperamos as fotos em paralelo com um limite de tempo
    // PRÓPRIO POR FOTO: cada uma tem até 8s pra carregar; a que não
    // conseguir simplesmente fica pra trás (o "onerror" no HTML já troca
    // pela imagem "sem imagem") sem travar as outras nem o restante da
    // geração. Isso deixa o tempo total previsível mesmo com lotes
    // grandes, em vez de crescer junto com a quantidade de produtos.
    await page.evaluate(() => {
      const imagens = Array.from(document.images);
      return Promise.all(
        imagens.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((resolve) => {
            const finalizar = () => {
              img.removeEventListener('load', finalizar);
              img.removeEventListener('error', finalizar);
              resolve();
            };
            img.addEventListener('load', finalizar);
            img.addEventListener('error', finalizar);
            setTimeout(finalizar, 8000);
          });
        })
      );
    });

    const buffer = await page.pdf({ format: 'A4', printBackground: true });
    await fs.writeFile(caminhoDestino, buffer);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        // No Windows o Chromium às vezes falha ao apagar a pasta temporária do
        // perfil (arquivo bloqueado por antivírus/outro processo em segundo
        // plano) mesmo depois do PDF já ter sido gerado com sucesso. Sem esse
        // try/catch aqui, esse erro de limpeza "engolia" o PDF pronto e
        // derrubava a geração inteira — por isso só avisamos no log e seguimos.
        console.warn('Aviso: falha ao fechar o Chromium (ignorado):', err.message);
      }
    }
  }
}

// Une vários PDFs (um arquivo por lote, já salvos em disco) num único PDF
// final, na ordem em que foram gerados. Usa "pdf-lib" (não abre Chrome
// nenhum — só remonta as páginas já prontas) e lê um arquivo de cada vez,
// então usa pouquíssima memória mesmo com muitos lotes.
async function juntarPdfsDeArquivos(caminhos) {
  if (caminhos.length === 1) return fs.readFile(caminhos[0]);
  const final = await PDFDocument.create();
  for (const caminho of caminhos) {
    const bytes = await fs.readFile(caminho);
    const doc = await PDFDocument.load(bytes);
    const paginas = await final.copyPages(doc, doc.getPageIndices());
    paginas.forEach((pagina) => final.addPage(pagina));
  }
  return Buffer.from(await final.save());
}

async function gerarPdfBuffer(produtos) {
  const produtosComImagem = produtos.map((p) => ({ ...p, img: p.imagem || SEM_IMAGEM_DATA_URL }));
  const todasPaginas = montarPaginas(produtosComImagem);

  // fatia a lista de páginas (não os produtos direto, porque os banners já
  // entram intercalados) em lotes de até LOTE_PAGINAS_PDF páginas cada
  const lotes = [];
  for (let i = 0; i < todasPaginas.length; i += LOTE_PAGINAS_PDF) {
    lotes.push(todasPaginas.slice(i, i + LOTE_PAGINAS_PDF));
  }
  if (lotes.length === 0) lotes.push([]); // catálogo sem produtos (só a capa)

  await fs.mkdir(TMP_DIR, { recursive: true });

  // Cada lote é renderizado por um processo do Chrome NOVO (ver
  // renderizarLoteParaArquivo acima) e salvo direto num arquivo temporário
  // em disco — nunca ficamos com vários PDFs inteiros abertos ao mesmo
  // tempo na memória do Node, só o arquivo de cada lote por vez.
  const caminhosLotes = [];
  try {
    let numeroAtual = 2;
    for (let i = 0; i < lotes.length; i++) {
      const lote = lotes[i];
      const html = gerarHTML(lote, produtos.length, {
        incluirCapa: i === 0,
        numeroInicial: numeroAtual
      });
      numeroAtual += lote.length;

      const nomeLote = `lote-${crypto.randomBytes(8).toString('hex')}.pdf`;
      const caminhoLote = path.join(TMP_DIR, nomeLote);
      await renderizarLoteParaArquivo(html, caminhoLote);
      caminhosLotes.push(caminhoLote);
    }

    return await juntarPdfsDeArquivos(caminhosLotes);
  } finally {
    // Limpa todos os arquivos temporários de lote, mesmo se algo deu
    // errado no meio do caminho — não deixa lixo acumulando em disco.
    await Promise.all(
      caminhosLotes.map((caminho) =>
        fs.unlink(caminho).catch(() => {})
      )
    );
  }
}

function mensagemLimiteExcedido(produtos) {
  return (
    `O catálogo filtrado tem ${produtos.length} produtos — bem acima do que ` +
    `esse catálogo costuma ter no total. Por segurança, o servidor gera no ` +
    `máximo ${MAX_PRODUTOS_POR_GERACAO} produtos de uma vez (acima disso, o ` +
    `plano gratuito do servidor pode ficar sem memória e o site fica fora ` +
    `do ar por alguns instantes). Use a busca, ou escolha uma categoria ` +
    `ou marca específica no site, pra reduzir a quantidade antes de gerar.`
  );
}

app.get('/gerar-pdf', async (req, res) => {
  try {
    const produtos = await filtrarProdutos(req);
    if (produtos.length === 0) {
      return res.status(404).send('Nenhum produto encontrado para gerar o catálogo.');
    }
    if (produtos.length > MAX_PRODUTOS_POR_GERACAO) {
      return res.status(413).send(mensagemLimiteExcedido(produtos));
    }

    // se já geramos esse mesmo PDF (mesma busca/categoria/marca) há pouco
    // tempo, reaproveita em vez de acionar o Chrome headless de novo — é o
    // que faz o botão responder na hora depois do primeiro clique
    const chave = chaveCache(req);
    const cacheado = cachePdf.get(chave);
    let pdfBuffer;
    if (cacheado && Date.now() - cacheado.geradoEm < PDF_CACHE_TTL_MS) {
      pdfBuffer = cacheado.buffer;
    } else {
      pdfBuffer = await gerarPdfBuffer(produtos);
      cachePdf.set(chave, { buffer: pdfBuffer, geradoEm: Date.now() });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="catalogo-vesco.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Erro /gerar-pdf:', err);
    res.status(500).send('Erro ao gerar o PDF: ' + err.message);
  }
});

// ---------------------------------------------------------------
// PDF do carrinho de orçamento (botão "Gerar PDF do carrinho" no site) —
// recebe a lista de produtos+quantidade que a pessoa montou no carrinho
// e devolve um PDF só com esses itens, quantidade e subtotal de cada um.
// ---------------------------------------------------------------
app.post('/gerar-pdf-carrinho', async (req, res) => {
  try {
    const itens = Array.isArray(req.body && req.body.itens) ? req.body.itens : [];
    if (itens.length === 0) {
      return res.status(400).send('Carrinho vazio.');
    }
    if (itens.length > 300) {
      return res.status(413).send('Carrinho com produtos demais pra gerar de uma vez.');
    }

    const pdfBuffer = await gerarPdfCarrinho(itens);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="orcamento-vesco.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Erro /gerar-pdf-carrinho:', err);
    res.status(500).send('Erro ao gerar o PDF do carrinho: ' + err.message);
  }
});

// ---------------------------------------------------------------
// Gera o PDF e manda pro Heyzine, que devolve um link de catálogo em
// formato "revista digital" (efeito de página realista, pronto pra
// compartilhar) — é o que o botão "Ver como revista online" usa.
// ---------------------------------------------------------------
// Sobe um PDF já pronto (buffer) pro Heyzine e devolve o link da revista
// digital. Extraída da rota abaixo pra também poder ser chamada pelo
// pré-aquecimento automático do cache (preAquecerCacheCompleto), que roda
// sozinho em segundo plano, sem uma requisição de visitante por trás.
async function converterParaFlipbook(pdfBuffer, baseUrl) {
  // salva o PDF temporariamente numa pasta pública, pra ter uma URL que o
  // Heyzine consiga baixar (a API dele pede uma URL, não aceita upload direto)
  await fs.mkdir(TMP_DIR, { recursive: true });
  const nomeArquivo = `catalogo-${crypto.randomBytes(8).toString('hex')}.pdf`;
  const caminhoTemp = path.join(TMP_DIR, nomeArquivo);
  await fs.writeFile(caminhoTemp, pdfBuffer);

  try {
    const urlPdfPublico = `${baseUrl}/tmp/${nomeArquivo}`;

    // O endpoint /api1/rest autentica via "client_id" no corpo da requisição
    // (não via header Authorization — esse é usado só em outros endpoints
    // de gestão do Heyzine).
    const respostaHeyzine = await fetch('https://heyzine.com/api1/rest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pdf: urlPdfPublico,
        client_id: HEYZINE_CLIENT_ID,
        title: 'Catálogo Vesco'
      })
    });

    const corpoResposta = await respostaHeyzine.text();
    let dados;
    try {
      dados = JSON.parse(corpoResposta);
    } catch (e) {
      throw new Error('Resposta inesperada do Heyzine: ' + corpoResposta.slice(0, 500));
    }

    if (!respostaHeyzine.ok || !dados.url) {
      throw new Error(
        'Heyzine retornou erro: ' + JSON.stringify(dados) +
        ' (URL do PDF que o servidor tentou enviar: ' + urlPdfPublico + ')'
      );
    }

    return dados.url;
  } finally {
    fs.unlink(caminhoTemp).catch(() => {});
  }
}

app.get('/gerar-flipbook', async (req, res) => {
  try {
    if (!HEYZINE_CLIENT_ID) {
      return res.status(500).send('HEYZINE_CLIENT_ID não configurada no servidor.');
    }

    const produtos = await filtrarProdutos(req);
    if (produtos.length === 0) {
      return res.status(404).send('Nenhum produto encontrado para gerar o catálogo.');
    }
    if (produtos.length > MAX_PRODUTOS_POR_GERACAO) {
      return res.status(413).send(mensagemLimiteExcedido(produtos));
    }

    // se essa mesma combinação de filtros já virou um link do Heyzine há
    // pouco tempo, reaproveita em vez de gerar o PDF de novo e subir pro
    // Heyzine de novo — sem isso, cada clique criava um catálogo novo lá
    // (lento, e ainda deixava link antigo "solto" na conta do Heyzine)
    const chave = chaveCache(req);
    const cacheado = cacheFlipbook.get(chave);
    if (cacheado && Date.now() - cacheado.geradoEm < PDF_CACHE_TTL_MS) {
      return res.redirect(cacheado.url);
    }

    const pdfBuffer = await gerarPdfBuffer(produtos);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const urlFlipbook = await converterParaFlipbook(pdfBuffer, baseUrl);

    cacheFlipbook.set(chave, { url: urlFlipbook, geradoEm: Date.now() });
    // já que o PDF foi gerado agora mesmo, deixa também no cache do
    // "Baixar catálogo em PDF" — evita gerar tudo de novo se o próximo
    // clique for nesse outro botão, com os mesmos filtros
    cachePdf.set(chave, { buffer: pdfBuffer, geradoEm: Date.now() });

    res.redirect(urlFlipbook);
  } catch (err) {
    console.error('Erro /gerar-flipbook:', err);
    res.status(500).send('Erro ao gerar o catálogo em revista digital: ' + err.message);
  }
});

// ---------------------------------------------------------------
// Pré-aquecimento automático do cache do catálogo COMPLETO (sem filtro
// nenhum) — é o caso mais comum, de longe. Em vez de esperar alguém clicar
// e só aí ligar o Chrome (deixando esse primeiro visitante esperando o
// processo inteiro), o servidor gera esse PDF/revista sozinho, em segundo
// plano, assim que sobe e depois periodicamente — pra quando um visitante
// clicar, o link já estar pronto e a resposta ser praticamente instantânea
// (é basicamente o mesmo motivo do catálogo de um concorrente citado numa
// conversa anterior "ser rápido": o dele é sempre um arquivo pronto, nunca
// gerado na hora). Buscas com filtro (categoria/marca/texto) continuam
// sendo geradas só quando alguém pede — são mais raras e, por terem menos
// produtos, já são naturalmente mais rápidas.
async function preAquecerCacheCompleto() {
  try {
    const produtos = await filtrarProdutos({ query: {} });
    if (produtos.length === 0) {
      console.warn('Pré-aquecimento do cache pulado: nenhum produto encontrado na planilha.');
      return;
    }
    if (produtos.length > MAX_PRODUTOS_POR_GERACAO) {
      console.warn(
        `Pré-aquecimento do cache pulado: catálogo com ${produtos.length} produtos, ` +
        `acima do limite de segurança (${MAX_PRODUTOS_POR_GERACAO}).`
      );
      return;
    }

    console.log(`Pré-aquecendo cache do catálogo completo (${produtos.length} produtos)...`);
    const pdfBuffer = await gerarPdfBuffer(produtos);
    cachePdf.set(CHAVE_CACHE_TUDO, { buffer: pdfBuffer, geradoEm: Date.now() });
    console.log('Cache do PDF completo pronto.');

    if (HEYZINE_CLIENT_ID && SITE_URL) {
      const urlFlipbook = await converterParaFlipbook(pdfBuffer, SITE_URL);
      cacheFlipbook.set(CHAVE_CACHE_TUDO, { url: urlFlipbook, geradoEm: Date.now() });
      console.log('Cache da revista digital completa pronto.');
    } else if (HEYZINE_CLIENT_ID) {
      console.warn(
        'Pré-aquecimento da revista digital pulado: defina a variável de ambiente ' +
        'SITE_URL (com o link público do site, ex.: https://catalogo.vesco.com.br) para ativar.'
      );
    }
  } catch (err) {
    // Nunca deixa um erro aqui derrubar o servidor — na pior das hipóteses,
    // o pré-aquecimento simplesmente não funcionou dessa vez, e o primeiro
    // clique de um visitante gera na hora, do jeito que já funcionava antes.
    console.error(
      'Erro ao pré-aquecer o cache do catálogo completo (o site continua funcionando ' +
      'normalmente; só o primeiro clique de um visitante pode demorar mais):',
      err.message
    );
  }
}

// Renova o cache um pouco antes dele vencer (PDF_CACHE_TTL_MS = 2h), pra um
// visitante nunca pegar o cache expirado e ter que esperar a geração do zero.
const PRE_AQUECER_INTERVALO_MS = 100 * 60 * 1000; // 100 minutos
garantirChromeInstalado(); // confere/baixa o Chrome em segundo plano assim que o servidor sobe
setTimeout(preAquecerCacheCompleto, 5000); // espera o servidor terminar de subir
setInterval(preAquecerCacheCompleto, PRE_AQUECER_INTERVALO_MS);

// Liga o servidor sempre (sem depender de "require.main === module").
// Alguns painéis de hospedagem (Hostinger/hPanel, cPanel com Passenger,
// entre outros) carregam esse arquivo através do próprio sistema deles
// pra gerenciar o processo — nesses casos "require.main" nunca é
// exatamente igual a este arquivo, então aquela checagem antiga nunca
// era verdadeira e o app.listen() nunca rodava, deixando a aplicação de
// pé mas sem escutar em porta nenhuma ("App did not call listen()").
app.listen(PORT, () => {
  console.log(`Catálogo Vesco rodando em http://localhost:${PORT}`);
});

// exportado só para possibilitar testes automatizados do template do PDF
module.exports = {
  gerarHTML,
  gerarHTMLCarrinho,
  gerarPdfCarrinho,
  montarPaginas,
  formatarPreco,
  escapeHtml,
  normalizarProduto,
  precoNumericoServidor
};

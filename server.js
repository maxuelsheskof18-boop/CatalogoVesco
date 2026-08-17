// server.js — Catálogo Vesco: site + gerador de PDF com um clique
// Executar: npm install && npm start
'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

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

const ITEMS_PER_PAGE = 8;
const BANNER_EVERY_PAGES = 4;

// Limite de segurança: gerar o catálogo inteiro (centenas de produtos, cada
// um com foto) de uma vez usa bastante memória no Chrome headless. No plano
// gratuito do Render (512 MB de RAM) isso pode estourar a memória e derrubar
// o serviço inteiro (aparece como "502 Bad Gateway", sem nenhuma mensagem de
// erro clara). Em vez de deixar isso acontecer, cortamos aqui com uma
// mensagem explicando o que fazer. Pode aumentar esse número com segurança
// se o plano do Render for maior que o gratuito.
const MAX_PRODUTOS_POR_GERACAO = 200;

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
app.use(express.static(path.join(__dirname, 'public')));

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

function normalizarProduto(p) {
  const imagemBruta = (p.imagem || '').trim();
  const imagemValida = imagemBruta.startsWith('http') ? imagemBruta : '';
  return {
    codigo: p.codigo || '',
    produto: p.produto || '',
    marca: p.marca || '',
    categoria: p.categoria || '',
    custo: p.custo || '',
    venda: p.venda || '',
    imagem: imagemValida,
    gtin: p.gtin || '',
    id: p.id || ''
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
function montarPaginas(produtos) {
  const paginasProdutos = [];
  for (let i = 0; i < produtos.length; i += ITEMS_PER_PAGE) {
    paginasProdutos.push(produtos.slice(i, i + ITEMS_PER_PAGE));
  }
  const paginas = [];
  for (let i = 0; i < paginasProdutos.length; i++) {
    paginas.push({ type: 'produtos', items: paginasProdutos[i] });
    if ((i + 1) % BANNER_EVERY_PAGES === 0 && i !== paginasProdutos.length - 1) {
      paginas.push({ type: 'banner' });
    }
  }
  return paginas;
}

function gerarHTML(paginas, totalProdutos) {
  const dataGeracao = new Date().toLocaleDateString('pt-BR');

  const capa = `
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
      const numero = idx + 2;
      if (pagina.type === 'banner') {
        return `
        <section class="pagina">
          ${cabecalho(numero)}
          <div class="banner">
            <h2>Linha Destaque</h2>
            <p>Produtos com qualidade e performance para o seu negócio.</p>
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
  .grade { flex:1; display:grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(4, 1fr); gap:16px 18px; }
  .produto { display:flex; gap:14px; border:1px solid #e6ecf0; border-radius:12px; padding:12px; align-items:center; height:100%; box-shadow:0 2px 8px rgba(0,51,77,.05); }
  .produto-img { width:100px; height:100px; flex:0 0 100px; display:flex; align-items:center; justify-content:center; background:#f8fafb; border:1px solid #e6ecf0; border-radius:10px; overflow:hidden; }
  .produto-img img { max-width:100%; max-height:100%; object-fit:contain; }
  .produto-info { flex:1; min-width:0; }
  .produto-marca { color:#00a859; font-weight:800; font-size:10px; text-transform:uppercase; letter-spacing:.5px; }
  .produto-nome { font-weight:700; font-size:13px; line-height:1.3; margin:4px 0; color:#0f2a3d; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .produto-cod { font-size:10.5px; color:#6b7c85; }
  .produto-preco { display:inline-block; margin-top:6px; padding:3px 11px; border-radius:999px; background:rgba(0,168,89,.12); color:#00753d; font-weight:800; font-size:13.5px; }
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

async function filtrarProdutos(req) {
  const busca = String(req.query.busca || '').trim().toLowerCase();
  const categoria = String(req.query.categoria || '').trim().toLowerCase();

  let produtos = await buscarProdutos();

  if (busca) {
    produtos = produtos.filter((p) =>
      `${p.produto} ${p.marca} ${p.codigo}`.toLowerCase().includes(busca)
    );
  }
  if (categoria) {
    produtos = produtos.filter((p) => (p.categoria || '').toLowerCase() === categoria);
  }
  produtos.sort((a, b) => a.produto.localeCompare(b.produto, 'pt-BR'));
  return produtos;
}

async function gerarPdfBuffer(produtos) {
  const produtosComImagem = produtos.map((p) => ({ ...p, img: p.imagem || SEM_IMAGEM_DATA_URL }));

  const paginas = montarPaginas(produtosComImagem);
  const html = gerarHTML(paginas, produtos.length);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 180000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.warn('Aviso: erro na página do PDF (ignorado):', err.message));

    // Só espera o HTML/CSS carregar aqui (rápido, não depende de rede
    // externa) — NÃO usamos "networkidle0" porque, com centenas de fotos
    // (URLs externas) carregando ao mesmo tempo, basta UMA foto lenta ou
    // travada pra isso nunca "ficar ocioso" e estourar o timeout inteiro
    // (foi exatamente o que causou o "Navigation timeout exceeded" com o
    // catálogo completo).
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Em vez disso, esperamos as fotos em paralelo com um limite de tempo
    // PRÓPRIO POR FOTO: cada uma tem até 8s pra carregar; a que não
    // conseguir simplesmente fica pra trás (o "onerror" no HTML já troca
    // pela imagem "sem imagem") sem travar as outras nem o restante da
    // geração. Isso deixa o tempo total previsível mesmo com catálogos
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

    return await page.pdf({ format: 'A4', printBackground: true });
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

function mensagemLimiteExcedido(produtos) {
  return (
    `O catálogo filtrado tem ${produtos.length} produtos, e o limite seguro ` +
    `para gerar de uma vez é ${MAX_PRODUTOS_POR_GERACAO} (acima disso o ` +
    `plano gratuito do servidor pode ficar sem memória e o site fica fora ` +
    `do ar por alguns instantes). Use a busca ou escolha uma categoria ` +
    `específica no site pra reduzir a quantidade antes de gerar.`
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

    const pdfBuffer = await gerarPdfBuffer(produtos);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="catalogo-vesco.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Erro /gerar-pdf:', err);
    res.status(500).send('Erro ao gerar o PDF: ' + err.message);
  }
});

// ---------------------------------------------------------------
// Gera o PDF e manda pro Heyzine, que devolve um link de catálogo em
// formato "revista digital" (efeito de página realista, pronto pra
// compartilhar) — é o que o botão "Ver como revista online" usa.
// ---------------------------------------------------------------
app.get('/gerar-flipbook', async (req, res) => {
  let caminhoTemp = null;
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

    const pdfBuffer = await gerarPdfBuffer(produtos);

    // salva o PDF temporariamente numa pasta pública, pra ter uma URL que o
    // Heyzine consiga baixar (a API dele pede uma URL, não aceita upload direto)
    await fs.mkdir(TMP_DIR, { recursive: true });
    const nomeArquivo = `catalogo-${crypto.randomBytes(8).toString('hex')}.pdf`;
    caminhoTemp = path.join(TMP_DIR, nomeArquivo);
    await fs.writeFile(caminhoTemp, pdfBuffer);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
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

    res.redirect(dados.url);
  } catch (err) {
    console.error('Erro /gerar-flipbook:', err);
    res.status(500).send('Erro ao gerar o catálogo em revista digital: ' + err.message);
  } finally {
    if (caminhoTemp) {
      fs.unlink(caminhoTemp).catch(() => {});
    }
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Catálogo Vesco rodando em http://localhost:${PORT}`);
  });
}

// exportado só para possibilitar testes automatizados do template do PDF
module.exports = { gerarHTML, montarPaginas, formatarPreco, escapeHtml, normalizarProduto };

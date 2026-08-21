(function () {
  'use strict';

  const ITEMS_PER_PAGE = 10;
  const BANNER_EVERY_PAGES = 4;

  const el = {
    busca: document.getElementById('busca'),
    categoria: document.getElementById('categoria'),
    marca: document.getElementById('marca'),
    ordenar: document.getElementById('ordenar'),
    btnBaixarPdf: document.getElementById('btnBaixarPdf'),
    btnVerRevista: document.getElementById('btnVerRevista'),
    statusCarregando: document.getElementById('statusCarregando'),
    statusErro: document.getElementById('statusErro'),
    statusVazio: document.getElementById('statusVazio'),
    livroWrap: document.getElementById('livroWrap'),
    livro: document.getElementById('livro'),
    gradeMobile: document.getElementById('gradeMobile'),
    contador: document.getElementById('contadorPagina'),
    btnAnterior: document.getElementById('btnAnterior'),
    btnProximo: document.getElementById('btnProximo')
  };

  let todosProdutos = [];
  let debounceTimer = null;

  function normalizarTexto(txt) {
    return String(txt || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function formatarPreco(v) {
    if (v === undefined || v === null || v === '' || Number(String(v).replace(',', '.')) === 0) {
      return 'Consulte';
    }
    const num = Number(String(v).replace(',', '.').replace(/[^\d.-]/g, ''));
    if (Number.isNaN(num)) return `R$ ${v}`;
    return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  async function carregarProdutos() {
    try {
      const resp = await fetch('/api/produtos');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      todosProdutos = await resp.json();
      preencherCategorias(todosProdutos);
      preencherMarcas(todosProdutos);
      el.statusCarregando.hidden = true;
      renderizar();
    } catch (err) {
      el.statusCarregando.hidden = true;
      el.statusErro.hidden = false;
      el.statusErro.textContent = 'Não foi possível carregar o catálogo agora. Tente recarregar a página.';
      console.error(err);
    }
  }

  function preencherCategorias(produtos) {
    const categorias = Array.from(
      new Set(produtos.map((p) => (p.categoria || '').trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    categorias.forEach((cat) => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      el.categoria.appendChild(opt);
    });
  }

  function preencherMarcas(produtos) {
    if (!el.marca) return;
    const marcas = Array.from(
      new Set(produtos.map((p) => (p.marca || '').trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    marcas.forEach((marca) => {
      const opt = document.createElement('option');
      opt.value = marca;
      opt.textContent = marca;
      el.marca.appendChild(opt);
    });
  }

  // Preço em número puro pra poder comparar/ordenar (a mesma lógica de
  // "sem preço = Consulte" usada em formatarPreco). Produtos sem preço
  // (ou preço zerado) voltam "null" aqui, pra sempre irem pro final da
  // lista quando ordenado por preço — nunca aparecem misturados no meio,
  // nem no topo, dos "menor/maior preço".
  function precoNumerico(p) {
    const num = Number(String(p.venda || '').replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  function produtosFiltrados() {
    const termo = normalizarTexto(el.busca.value);
    const categoria = el.categoria.value;
    const marca = el.marca ? el.marca.value : '';
    const ordenar = el.ordenar ? el.ordenar.value : '';

    let lista = todosProdutos;
    if (categoria) {
      lista = lista.filter((p) => (p.categoria || '') === categoria);
    }
    if (marca) {
      lista = lista.filter((p) => (p.marca || '') === marca);
    }
    if (termo) {
      const palavras = termo.split(' ').filter(Boolean);
      lista = lista.filter((p) => {
        const texto = normalizarTexto(`${p.produto} ${p.marca} ${p.codigo}`);
        return palavras.every((palavra) => texto.includes(palavra));
      });
    }

    if (ordenar === 'menor-preco' || ordenar === 'maior-preco') {
      const direcao = ordenar === 'menor-preco' ? 1 : -1;
      return lista.slice().sort((a, b) => {
        const pa = precoNumerico(a);
        const pb = precoNumerico(b);
        if (pa === null && pb === null) return (a.produto || '').localeCompare(b.produto || '', 'pt-BR');
        if (pa === null) return 1; // sem preço sempre vai pro final
        if (pb === null) return -1;
        return (pa - pb) * direcao;
      });
    }

    // "Mais vendidos" depende de uma marcação manual na planilha (coluna
    // "destaque" = "sim" nos produtos que você quer destacar) — ver
    // normalizarProduto no server.js. Os marcados vêm primeiro; dentro de
    // cada grupo (marcados / não marcados), continua em ordem alfabética.
    if (ordenar === 'mais-vendidos') {
      return lista.slice().sort((a, b) => {
        const da = a.destaque ? 1 : 0;
        const db = b.destaque ? 1 : 0;
        if (da !== db) return db - da;
        return (a.produto || '').localeCompare(b.produto || '', 'pt-BR');
      });
    }

    return lista.slice().sort((a, b) => (a.produto || '').localeCompare(b.produto || '', 'pt-BR'));
  }

  function atualizarLinkPdf() {
    const params = new URLSearchParams();
    if (el.busca.value.trim()) params.set('busca', el.busca.value.trim());
    if (el.categoria.value) params.set('categoria', el.categoria.value);
    if (el.marca && el.marca.value) params.set('marca', el.marca.value);
    const query = params.toString() ? '?' + params.toString() : '';
    el.btnBaixarPdf.href = '/gerar-pdf' + query;
    if (el.btnVerRevista) el.btnVerRevista.href = '/gerar-flipbook' + query;
  }

  // Frases da página de destaque que aparece entre os produtos — uma
  // diferente a cada vez que ela aparece (em vez de repetir sempre a
  // mesma), pra prender mais a atenção de quem está folheando.
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

  // incluirCapa = false quando tem uma busca/filtro ativo: nesse caso não
  // faz sentido mostrar a capa do catálogo primeiro (quem buscou já quer
  // ver o resultado direto) — a revista já abre direto na primeira página
  // com produto.
  function montarPaginasHTML(produtos, incluirCapa) {
    const paginasProdutos = [];
    for (let i = 0; i < produtos.length; i += ITEMS_PER_PAGE) {
      paginasProdutos.push(produtos.slice(i, i + ITEMS_PER_PAGE));
    }

    const paginas = [];
    if (incluirCapa) paginas.push(paginaCapa());

    const numeroInicial = incluirCapa ? 2 : 1;
    let contadorDestaque = 0;
    paginasProdutos.forEach((itens, idx) => {
      paginas.push(paginaProdutos(itens, numeroInicial + idx));
      if ((idx + 1) % BANNER_EVERY_PAGES === 0 && idx !== paginasProdutos.length - 1) {
        paginas.push(paginaBanner(contadorDestaque));
        contadorDestaque += 1;
      }
    });

    paginas.push(paginaContracapa());
    return paginas;
  }

  function paginaCapa() {
    const div = document.createElement('div');
    div.className = 'pagina-livro pagina-capa';
    div.innerHTML = `
      <div class="capa-marca">VESCO</div>
      <h1>Catálogo de Produtos</h1>
      <p>Soluções em Higiene e Limpeza</p>`;
    return div;
  }

  function paginaContracapa() {
    const div = document.createElement('div');
    div.className = 'pagina-livro pagina-capa';
    div.innerHTML = `
      <div class="capa-marca">CONTATO</div>
      <h1 style="font-size:20px;">Fale com a gente</h1>
      <p>WhatsApp (11) 98943-3272 · contato@vesco.com.br</p>`;
    return div;
  }

  function paginaBanner(indice) {
    const frase = FRASES_DESTAQUE[indice % FRASES_DESTAQUE.length];
    const div = document.createElement('div');
    div.className = 'pagina-livro';
    div.innerHTML = `
      <div class="pagina-banner">
        <h2>${escapeHtml(frase.titulo)}</h2>
        <p>${escapeHtml(frase.texto)}</p>
      </div>
      <div class="pagina-rodape">Catálogo Vesco — Soluções em Higiene e Limpeza</div>`;
    return div;
  }

  function paginaProdutos(itens, numero) {
    const div = document.createElement('div');
    div.className = 'pagina-livro';
    div.innerHTML = `
      <div class="pagina-cabecalho"><span>VESCO</span><span>${numero}</span></div>
      <div class="pagina-grade">
        ${itens.map(cartaoProdutoHTML).join('')}
      </div>
      <div class="pagina-rodape">Catálogo Vesco — Soluções em Higiene e Limpeza</div>`;
    return div;
  }

  function cartaoProdutoHTML(p) {
    const img = p.imagem || '/sem-imagem.svg';
    const nome = escapeHtml(p.produto || '');
    const selo = p.destaque ? '<span class="produto-selo">Mais vendido</span>' : '';
    return `
      <article class="produto-card">
        ${selo}
        <img src="${img}" alt="${nome}" loading="lazy" onerror="this.src='/sem-imagem.svg'"/>
        <div class="produto-info">
          <div class="produto-marca">${escapeHtml(p.marca || 'Vesco')}</div>
          <div class="produto-nome">${nome}</div>
          <div class="produto-cod">Cód: ${escapeHtml(p.codigo || '—')}</div>
          <div class="produto-preco">${formatarPreco(p.venda)}</div>
        </div>
      </article>`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Mede, na hora, quanto espaço realmente sobra na tela pro livro —
  // descontando a altura de verdade do cabeçalho, do rodapé e do
  // contador de página (que pode até quebrar em duas linhas em telas
  // estreitas). Guarda o resultado numa variável CSS (--livro-h) que o
  // style.css usa pra dimensionar o livro certinho, sem cortar nenhum
  // produto e sem nunca "vazar" pra fora da tela.
  function ajustarAlturaLivro() {
    const topoEl = document.querySelector('.topo');
    const rodapeEl = document.querySelector('.rodape-site');
    const topoH = topoEl ? topoEl.getBoundingClientRect().height : 0;
    const rodapeH = rodapeEl ? rodapeEl.getBoundingClientRect().height : 0;
    const contadorH = (el.contador && !el.contador.hidden)
      ? el.contador.getBoundingClientRect().height + 14
      : 0;
    // No celular as setas de navegação ficam ABAIXO do livro, não mais do
    // lado (ver o breakpoint de 640px no style.css) — isso ocupa uma
    // faixa extra de altura que precisa ser descontada aqui também,
    // senão o livro fica grande demais e empurra as setas (ou até o
    // rodapé do site) pra fora da tela. Mede a altura de verdade do
    // botão (em vez de um número fixo), então continua certo mesmo se o
    // tamanho da seta mudar no CSS no futuro.
    const setasEmBaixo = window.matchMedia('(max-width: 640px)').matches;
    const setasH = (setasEmBaixo && el.btnAnterior)
      ? el.btnAnterior.getBoundingClientRect().height + 20
      : 0;
    const folga = 20; // respiro extra pra não colar nas bordas
    const disponivel = Math.max(260, window.innerHeight - topoH - rodapeH - contadorH - setasH - folga);
    document.documentElement.style.setProperty('--livro-h', disponivel + 'px');
  }

  function renderizar() {
    atualizarLinkPdf();
    const lista = produtosFiltrados();

    if (lista.length === 0) {
      el.livroWrap.hidden = true;
      el.contador.hidden = true;
      el.statusVazio.hidden = false;
      return;
    }
    el.statusVazio.hidden = true;

    // sempre no formato "revista" (livro com efeito de virar página) —
    // em qualquer tela, do celular ao PC — só o tamanho do livro que se
    // adapta, o jeito de usar é sempre o mesmo.
    renderizarLivro(lista);
  }

  // ---------------------------------------------------------------
  // Efeito de "virar página" feito com CSS 3D + JS puro (sem depender
  // de nenhuma biblioteca externa/CDN — só o navegador do usuário).
  // ---------------------------------------------------------------
  class LivroFlip {
    constructor(container, paginasEl) {
      this.container = container;
      this.paginas = paginasEl;
      this.atual = 0;
      this.animando = false;

      this.container.innerHTML = '';
      this.paginas.forEach((p) => this.container.appendChild(p));
      this.paginas[0].classList.add('st-instant', 'st-ativa');
      requestAnimationFrame(() => this.paginas[0].classList.remove('st-instant'));
    }

    get total() { return this.paginas.length; }

    proxima() {
      if (this.animando || this.atual >= this.total - 1) return;
      this._transicao(this.atual + 1, 'dir');
    }

    anterior() {
      if (this.animando || this.atual <= 0) return;
      this._transicao(this.atual - 1, 'esq');
    }

    _transicao(novoIndex, direcao) {
      this.animando = true;
      const atualEl = this.paginas[this.atual];
      const novaEl = this.paginas[novoIndex];

      const classeSaida = direcao === 'dir' ? 'st-saindo-esq' : 'st-saindo-dir';
      const classeEntradaInicial = direcao === 'dir' ? 'st-entrando-dir' : 'st-entrando-esq';

      atualEl.classList.remove('st-ativa');
      atualEl.classList.add(classeSaida);

      novaEl.classList.add('st-instant', classeEntradaInicial);
      void novaEl.offsetWidth; // força o navegador a aplicar o estado inicial sem animar
      novaEl.classList.remove('st-instant');

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          novaEl.classList.remove(classeEntradaInicial);
          novaEl.classList.add('st-ativa');
        });
      });

      this.atual = novoIndex;
      atualizarContador(this);

      setTimeout(() => {
        atualEl.classList.remove(classeSaida);
        this.animando = false;
      }, 520);
    }
  }

  let livroFlip = null;

  // true quando busca/categoria/marca está filtrando o catálogo — nesse
  // caso a capa não aparece (ver montarPaginasHTML). "Ordenar" não conta
  // como filtro aqui porque ele não reduz a lista, só muda a ordem.
  function temFiltroAtivo() {
    return !!(el.busca.value.trim() || el.categoria.value || (el.marca && el.marca.value));
  }

  function renderizarLivro(lista) {
    el.gradeMobile.hidden = true;
    el.livroWrap.hidden = false;
    el.contador.hidden = false;
    ajustarAlturaLivro();

    const paginas = montarPaginasHTML(lista, !temFiltroAtivo());
    livroFlip = new LivroFlip(el.livro, paginas);
    atualizarContador(livroFlip);
  }

  function atualizarContador(flip) {
    if (!flip) return;
    el.contador.textContent = `Página ${flip.atual + 1} de ${flip.total}`;
  }

  el.btnAnterior.addEventListener('click', () => livroFlip && livroFlip.anterior());
  el.btnProximo.addEventListener('click', () => livroFlip && livroFlip.proxima());

  // Passar o dedo pra virar a página (celular/tablet) — compara o quanto
  // o dedo andou na horizontal vs. na vertical, pra só disparar a virada
  // quando o gesto for claramente um "arrastar de lado" (senão um scroll
  // vertical comum acabaria virando página sem querer).
  (function ativarGestoDeArrastar() {
    let inicioX = 0;
    let inicioY = 0;
    el.livroWrap.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      inicioX = t.clientX;
      inicioY = t.clientY;
    }, { passive: true });

    el.livroWrap.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - inicioX;
      const dy = t.clientY - inicioY;
      const LIMIAR = 40;
      if (Math.abs(dx) > LIMIAR && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) livroFlip && livroFlip.proxima();
        else livroFlip && livroFlip.anterior();
      }
    }, { passive: true });
  })();

  el.busca.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderizar, 250);
  });
  el.categoria.addEventListener('change', renderizar);
  if (el.marca) el.marca.addEventListener('change', renderizar);
  if (el.ordenar) el.ordenar.addEventListener('change', renderizar);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderizar, 300);
  });

  // a fonte (Google Fonts) carrega de forma assíncrona e pode alterar
  // ligeiramente a altura do cabeçalho depois da primeira medição —
  // por isso recalcula assim que ela termina de carregar.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(ajustarAlturaLivro).catch(() => {});
  }
  window.addEventListener('load', ajustarAlturaLivro);

  carregarProdutos();
})();

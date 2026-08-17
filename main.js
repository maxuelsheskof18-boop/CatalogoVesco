(function () {
  'use strict';

  const ITEMS_PER_PAGE = 6;
  const BANNER_EVERY_PAGES = 4;
  const MOBILE_BREAKPOINT = 780;

  const el = {
    busca: document.getElementById('busca'),
    categoria: document.getElementById('categoria'),
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

  function produtosFiltrados() {
    const termo = normalizarTexto(el.busca.value);
    const categoria = el.categoria.value;

    let lista = todosProdutos;
    if (categoria) {
      lista = lista.filter((p) => (p.categoria || '') === categoria);
    }
    if (termo) {
      const palavras = termo.split(' ').filter(Boolean);
      lista = lista.filter((p) => {
        const texto = normalizarTexto(`${p.produto} ${p.marca} ${p.codigo}`);
        return palavras.every((palavra) => texto.includes(palavra));
      });
    }
    return lista.slice().sort((a, b) => (a.produto || '').localeCompare(b.produto || '', 'pt-BR'));
  }

  function atualizarLinkPdf() {
    const params = new URLSearchParams();
    if (el.busca.value.trim()) params.set('busca', el.busca.value.trim());
    if (el.categoria.value) params.set('categoria', el.categoria.value);
    const query = params.toString() ? '?' + params.toString() : '';
    el.btnBaixarPdf.href = '/gerar-pdf' + query;
    if (el.btnVerRevista) el.btnVerRevista.href = '/gerar-flipbook' + query;
  }

  function montarPaginasHTML(produtos) {
    const paginasProdutos = [];
    for (let i = 0; i < produtos.length; i += ITEMS_PER_PAGE) {
      paginasProdutos.push(produtos.slice(i, i + ITEMS_PER_PAGE));
    }

    const paginas = [];
    paginas.push(paginaCapa());

    paginasProdutos.forEach((itens, idx) => {
      paginas.push(paginaProdutos(itens, idx + 2));
      if ((idx + 1) % BANNER_EVERY_PAGES === 0 && idx !== paginasProdutos.length - 1) {
        paginas.push(paginaBanner());
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

  function paginaBanner() {
    const div = document.createElement('div');
    div.className = 'pagina-livro';
    div.innerHTML = `
      <div class="pagina-banner">
        <h2>Linha Destaque</h2>
        <p>Produtos com qualidade e performance para o seu negócio.</p>
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
    return `
      <article class="produto-card">
        <img src="${img}" alt="${nome}" loading="lazy" onerror="this.src='/sem-imagem.svg'"/>
        <div>
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

  function ehModoMobile() {
    return window.innerWidth < MOBILE_BREAKPOINT;
  }

  function renderizar() {
    atualizarLinkPdf();
    const lista = produtosFiltrados();

    if (lista.length === 0) {
      el.livroWrap.hidden = true;
      el.contador.hidden = true;
      el.gradeMobile.hidden = true;
      el.statusVazio.hidden = false;
      return;
    }
    el.statusVazio.hidden = true;

    if (ehModoMobile()) {
      renderizarGradeMobile(lista);
    } else {
      renderizarLivro(lista);
    }
  }

  function renderizarGradeMobile(lista) {
    el.livroWrap.hidden = true;
    el.contador.hidden = true;
    livroFlip = null;
    el.gradeMobile.hidden = false;
    el.gradeMobile.innerHTML = lista.map(cartaoProdutoHTML).join('');
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

  function renderizarLivro(lista) {
    el.gradeMobile.hidden = true;
    el.livroWrap.hidden = false;
    el.contador.hidden = false;

    const paginas = montarPaginasHTML(lista);
    livroFlip = new LivroFlip(el.livro, paginas);
    atualizarContador(livroFlip);
  }

  function atualizarContador(flip) {
    if (!flip) return;
    el.contador.textContent = `Página ${flip.atual + 1} de ${flip.total}`;
  }

  el.btnAnterior.addEventListener('click', () => livroFlip && livroFlip.anterior());
  el.btnProximo.addEventListener('click', () => livroFlip && livroFlip.proxima());

  el.busca.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderizar, 250);
  });
  el.categoria.addEventListener('change', renderizar);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderizar, 300);
  });

  carregarProdutos();
})();

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
    paginacao: document.getElementById('paginacao'),
    btnAnterior: document.getElementById('btnAnterior'),
    btnProximo: document.getElementById('btnProximo'),
    btnCarrinho: document.getElementById('btnCarrinho'),
    carrinhoContador: document.getElementById('carrinhoContador'),
    carrinhoOverlay: document.getElementById('carrinhoOverlay'),
    carrinhoLista: document.getElementById('carrinhoLista'),
    carrinhoTotal: document.getElementById('carrinhoTotal'),
    btnFecharCarrinho: document.getElementById('btnFecharCarrinho'),
    btnEsvaziarCarrinho: document.getElementById('btnEsvaziarCarrinho'),
    btnCarrinhoWhatsapp: document.getElementById('btnCarrinhoWhatsapp'),
    btnCarrinhoPdf: document.getElementById('btnCarrinhoPdf')
  };

  // Número de WhatsApp que recebe os pedidos do carrinho (formato
  // internacional, só dígitos, sem "+"). Pra trocar, é só editar essa
  // linha — o mesmo número que já aparece na contracapa do PDF.
  const WHATSAPP_NUMERO = '5511127614730';

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
  // Antes essa função já criava o HTML (com fotos e tudo) de TODAS as
  // páginas do catálogo de uma vez — com quase 800 produtos, isso é quase
  // mil fotos carregando ao mesmo tempo, o que travava o navegador
  // (por isso a seta de "próxima página" parecia não funcionar: o
  // navegador estava ocupado demais carregando fotos de páginas que
  // ninguém tinha nem chegado perto de ver ainda). Agora ela só monta uma
  // lista leve de "o que cada página vai ter" (sem criar nenhum elemento
  // nem carregar nenhuma foto) — quem realmente cria o HTML de uma
  // página, sob demanda, é o LivroFlip (ver mais abaixo).
  function montarPaginasDados(produtos, incluirCapa) {
    const paginasProdutos = [];
    for (let i = 0; i < produtos.length; i += ITEMS_PER_PAGE) {
      paginasProdutos.push(produtos.slice(i, i + ITEMS_PER_PAGE));
    }

    const paginas = [];
    if (incluirCapa) paginas.push({ tipo: 'capa' });

    const numeroInicial = incluirCapa ? 2 : 1;
    let contadorDestaque = 0;
    paginasProdutos.forEach((itens, idx) => {
      paginas.push({ tipo: 'produtos', itens, numero: numeroInicial + idx });
      if ((idx + 1) % BANNER_EVERY_PAGES === 0 && idx !== paginasProdutos.length - 1) {
        paginas.push({ tipo: 'banner', indice: contadorDestaque });
        contadorDestaque += 1;
      }
    });

    paginas.push({ tipo: 'contracapa' });
    return paginas;
  }

  // Constrói o HTML de UMA página só (com fotos), a partir do descritor
  // leve montado acima — é aqui que o "custo" de cada página realmente
  // acontece, e só é pago quando a página entra na janela visível (ver
  // LivroFlip._garantirMontada).
  function construirPaginaDOM(dados) {
    switch (dados.tipo) {
      case 'capa': return paginaCapa();
      case 'contracapa': return paginaContracapa();
      case 'banner': return paginaBanner(dados.indice);
      case 'produtos': return paginaProdutos(dados.itens, dados.numero);
      default: return paginaContracapa();
    }
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
    const codigo = escapeHtml(p.codigo || '');
    const selo = p.destaque ? '<span class="produto-selo">Mais vendido</span>' : '';
    return `
      <article class="produto-card">
        ${selo}
        <img src="${img}" alt="${nome}" loading="lazy" onerror="this.src='/sem-imagem.svg'"/>
        <div class="produto-info">
          <div class="produto-marca">${escapeHtml(p.marca || 'Vesco')}</div>
          <div class="produto-nome">${nome}</div>
          <div class="produto-cod">Cód: ${codigo || '—'}</div>
          <div class="produto-preco">${formatarPreco(p.venda)}</div>
        </div>
        <button class="produto-add-carrinho" type="button" data-codigo="${codigo}" aria-label="Adicionar ${nome} ao carrinho">+</button>
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
      if (el.paginacao) el.paginacao.hidden = true;
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
    constructor(container, dadosPaginas) {
      this.container = container;
      this.dados = dadosPaginas;
      this.atual = 0;
      this.animando = false;
      // index (número da página) -> elemento HTML já construído. Só as
      // páginas "por perto" da atual ficam aqui — é isso que evita
      // carregar as fotos do catálogo inteiro de uma vez (ver comentário
      // em montarPaginasDados, acima).
      this.montadas = new Map();

      this.container.innerHTML = '';
      const primeira = this._garantirMontada(0);
      primeira.classList.add('st-instant', 'st-ativa');
      requestAnimationFrame(() => primeira.classList.remove('st-instant'));
      // já deixa a segunda página pronta em segundo plano, pra primeira
      // vez que a pessoa clicar em "próxima" ser instantâneo também.
      this._garantirMontada(1);
    }

    get total() { return this.dados.length; }

    // Cria (se ainda não existir) o HTML de uma página específica e a
    // deixa no DOM, pronta pra aparecer. Chamado sob demanda: só quando
    // uma página realmente vai ser exibida (a atual ou uma vizinha).
    _garantirMontada(index) {
      if (index < 0 || index >= this.dados.length) return null;
      let elemento = this.montadas.get(index);
      if (!elemento) {
        elemento = construirPaginaDOM(this.dados[index]);
        this.container.appendChild(elemento);
        this.montadas.set(index, elemento);
      }
      return elemento;
    }

    // Remove do DOM (e da memória) as páginas que não estão mais perto da
    // atual — sem isso, depois de folhear o catálogo inteiro, todas as
    // quase 100 páginas (com suas fotos) ficariam acumuladas no HTML de
    // novo, do mesmo jeito que travava antes.
    _podarForaDaJanela() {
      const manter = new Set([this.atual - 1, this.atual, this.atual + 1]);
      for (const [index, elemento] of this.montadas) {
        if (!manter.has(index)) {
          elemento.remove();
          this.montadas.delete(index);
        }
      }
    }

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
      const atualEl = this.montadas.get(this.atual);
      const novaEl = this._garantirMontada(novoIndex);

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
        this._podarForaDaJanela();
        // já deixa a próxima vizinha (na direção que a pessoa está indo)
        // pronta em segundo plano, pra navegação seguida ficar fluida.
        this._garantirMontada(novoIndex + (direcao === 'dir' ? 1 : -1));
      }, 520);
    }

    // "Pula" direto pra uma página específica (usado pelos números da
    // paginação) — sem o efeito de virar página uma por uma, porque não
    // faria sentido animar 40 páginas de uma vez só quando a pessoa quer
    // ir direto da página 2 pra página 47, por exemplo.
    irParaPagina(indexAlvo) {
      if (this.animando || indexAlvo === this.atual || indexAlvo < 0 || indexAlvo >= this.total) return;
      const atualEl = this.montadas.get(this.atual);
      const novaEl = this._garantirMontada(indexAlvo);

      if (atualEl) {
        atualEl.classList.remove('st-ativa', 'st-saindo-esq', 'st-saindo-dir');
      }
      novaEl.classList.add('st-instant');
      novaEl.classList.add('st-ativa');
      void novaEl.offsetWidth;
      novaEl.classList.remove('st-instant');

      this.atual = indexAlvo;
      atualizarContador(this);
      this._podarForaDaJanela();
      this._garantirMontada(indexAlvo + 1);
    }
  }

  let livroFlip = null;

  // true quando busca/categoria/marca está filtrando o catálogo — nesse
  // caso a capa não aparece (ver montarPaginasDados). "Ordenar" não conta
  // como filtro aqui porque ele não reduz a lista, só muda a ordem.
  function temFiltroAtivo() {
    return !!(el.busca.value.trim() || el.categoria.value || (el.marca && el.marca.value));
  }

  function renderizarLivro(lista) {
    el.gradeMobile.hidden = true;
    el.livroWrap.hidden = false;
    el.contador.hidden = false;
    ajustarAlturaLivro();

    const paginas = montarPaginasDados(lista, !temFiltroAtivo());
    livroFlip = new LivroFlip(el.livro, paginas);
    atualizarContador(livroFlip);
  }

  function atualizarContador(flip) {
    if (!flip) return;
    el.contador.textContent = `Página ${flip.atual + 1} de ${flip.total}`;
    renderizarPaginacao(flip);
  }

  // Monta a lista de números clicáveis (tipo "1 2 3 ... 47 48 49 ... 99
  // Próximo"), igual a paginação de qualquer site de vendas — assim dá
  // pra pular direto pra uma página específica, sem precisar clicar em
  // "próxima" um monte de vezes. Sempre mostra a primeira e a última
  // página, mais uma "janela" de páginas perto de onde a pessoa está,
  // com "…" no meio quando tem um pulo grande.
  function construirListaPaginacao(atual, total) {
    const RAIO = 2; // quantas páginas mostrar de cada lado da atual
    const manter = new Set([0, total - 1]);
    for (let i = atual - RAIO; i <= atual + RAIO; i++) {
      if (i >= 0 && i < total) manter.add(i);
    }
    const indices = Array.from(manter).sort((a, b) => a - b);

    const itens = [];
    let anterior = null;
    indices.forEach((i) => {
      if (anterior !== null && i - anterior > 1) itens.push({ tipo: 'reticencias' });
      itens.push({ tipo: 'pagina', index: i });
      anterior = i;
    });
    return itens;
  }

  function renderizarPaginacao(flip) {
    if (!el.paginacao) return;
    if (!flip || flip.total <= 1) {
      el.paginacao.hidden = true;
      el.paginacao.innerHTML = '';
      return;
    }
    el.paginacao.hidden = false;
    const itens = construirListaPaginacao(flip.atual, flip.total);

    const botoesNumeros = itens.map((item) => {
      if (item.tipo === 'reticencias') return '<span class="paginacao-reticencias">…</span>';
      const ativo = item.index === flip.atual;
      return `<button type="button" class="paginacao-num${ativo ? ' paginacao-ativa' : ''}" data-pagina="${item.index}" ${ativo ? 'aria-current="page"' : ''}>${item.index + 1}</button>`;
    }).join('');

    const temAnterior = flip.atual > 0;
    const temProximo = flip.atual < flip.total - 1;
    const linkAnterior = temAnterior ? '<button type="button" class="paginacao-link" data-acao="anterior">‹ Anterior</button>' : '';
    const linkProximo = temProximo ? '<button type="button" class="paginacao-link" data-acao="proximo">Próximo ›</button>' : '';

    el.paginacao.innerHTML = `${linkAnterior}${botoesNumeros}${linkProximo}`;
  }

  el.btnAnterior.addEventListener('click', () => livroFlip && livroFlip.anterior());
  el.btnProximo.addEventListener('click', () => livroFlip && livroFlip.proxima());

  if (el.paginacao) {
    el.paginacao.addEventListener('click', (e) => {
      if (!livroFlip) return;
      const botaoNum = e.target.closest('.paginacao-num');
      if (botaoNum) {
        livroFlip.irParaPagina(Number(botaoNum.dataset.pagina));
        return;
      }
      const acao = e.target.closest('.paginacao-link');
      if (acao) {
        if (acao.dataset.acao === 'anterior') livroFlip.anterior();
        else if (acao.dataset.acao === 'proximo') livroFlip.proxima();
      }
    });
  }

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

  // ---------------------------------------------------------------
  // Carrinho de orçamento — junta produtos pra mandar no WhatsApp ou
  // gerar um PDF só com eles (com quantidade e subtotal de cada um).
  // Guardado no localStorage do navegador (por aparelho/navegador, não
  // sincroniza entre dispositivos — não precisa de login nem servidor).
  // ---------------------------------------------------------------
  const CARRINHO_STORAGE_KEY = 'vesco-carrinho';
  let carrinho = carregarCarrinho();

  function carregarCarrinho() {
    try {
      const bruto = JSON.parse(localStorage.getItem(CARRINHO_STORAGE_KEY) || '{}');
      return bruto && typeof bruto === 'object' ? bruto : {};
    } catch {
      return {};
    }
  }

  function salvarCarrinho() {
    try {
      localStorage.setItem(CARRINHO_STORAGE_KEY, JSON.stringify(carrinho));
    } catch {
      // localStorage indisponível (modo privado, cookies bloqueados etc.) —
      // o carrinho continua funcionando normalmente durante a visita, só
      // não é lembrado na próxima vez.
    }
  }

  function itensCarrinhoDetalhados() {
    return Object.keys(carrinho)
      .map((codigo) => {
        const produto = todosProdutos.find((p) => String(p.codigo) === codigo);
        if (!produto) return null;
        const quantidade = carrinho[codigo];
        const precoUnit = precoNumerico(produto);
        const subtotal = precoUnit === null ? null : precoUnit * quantidade;
        return { produto, quantidade, precoUnit, subtotal };
      })
      .filter(Boolean);
  }

  function totalCarrinho(itens) {
    return itens.reduce((soma, it) => soma + (it.subtotal || 0), 0);
  }

  function atualizarContadorCarrinho() {
    const total = Object.values(carrinho).reduce((soma, q) => soma + q, 0);
    el.carrinhoContador.textContent = String(total);
    el.carrinhoContador.hidden = total === 0;
  }

  function adicionarAoCarrinho(codigo) {
    if (!codigo) return;
    carrinho[codigo] = (carrinho[codigo] || 0) + 1;
    salvarCarrinho();
    atualizarContadorCarrinho();
    mostrarToast('Adicionado ao carrinho');
    if (!el.carrinhoOverlay.hidden) renderizarCarrinho();
  }

  function alterarQuantidadeCarrinho(codigo, delta) {
    if (!carrinho[codigo]) return;
    carrinho[codigo] += delta;
    if (carrinho[codigo] <= 0) delete carrinho[codigo];
    salvarCarrinho();
    atualizarContadorCarrinho();
    renderizarCarrinho();
  }

  // Define a quantidade digitada direto no campo (em vez de só somar/
  // subtrair de um em um nos botões "+"/"−") — usada quando a pessoa quer
  // pedir uma quantidade maior de uma vez, sem precisar clicar várias
  // vezes. Sempre um número inteiro entre 1 e 9999 (mesmo limite que o
  // servidor já aplica na hora de gerar o PDF do orçamento); qualquer
  // valor inválido ou vazio simplesmente volta pra quantidade anterior.
  function definirQuantidadeCarrinho(codigo, valorDigitado) {
    if (!carrinho[codigo]) return;
    const numero = Math.floor(Number(valorDigitado));
    if (!Number.isFinite(numero) || numero < 1) {
      renderizarCarrinho(); // desfaz visualmente, voltando pro valor salvo
      return;
    }
    carrinho[codigo] = Math.min(numero, 9999);
    salvarCarrinho();
    atualizarContadorCarrinho();
    renderizarCarrinho();
  }

  function removerDoCarrinho(codigo) {
    delete carrinho[codigo];
    salvarCarrinho();
    atualizarContadorCarrinho();
    renderizarCarrinho();
  }

  function esvaziarCarrinho() {
    carrinho = {};
    salvarCarrinho();
    atualizarContadorCarrinho();
    renderizarCarrinho();
  }

  function carrinhoItemHTML(it) {
    const img = it.produto.imagem || '/sem-imagem.svg';
    const nome = escapeHtml(it.produto.produto || '');
    const codigo = escapeHtml(it.produto.codigo || '');
    const subtotalTexto = it.subtotal === null ? 'Consulte' : formatarPreco(it.subtotal);
    return `
      <div class="carrinho-item" data-codigo="${codigo}">
        <img src="${img}" alt="${nome}" onerror="this.src='/sem-imagem.svg'"/>
        <div class="carrinho-item-info">
          <div class="carrinho-item-nome">${nome}</div>
          <div class="carrinho-item-preco">SKU: ${codigo || '—'} · ${formatarPreco(it.produto.venda)} cada</div>
          <div class="carrinho-item-controles">
            <span class="carrinho-item-qtd">
              <button type="button" class="carrinho-diminuir" aria-label="Diminuir quantidade">−</button>
              <input
                type="number"
                class="carrinho-item-input"
                inputmode="numeric"
                min="1"
                max="9999"
                step="1"
                value="${it.quantidade}"
                aria-label="Quantidade"
              />
              <button type="button" class="carrinho-aumentar" aria-label="Aumentar quantidade">+</button>
            </span>
            <button type="button" class="carrinho-item-remover">remover</button>
          </div>
        </div>
        <div class="carrinho-item-subtotal">${subtotalTexto}</div>
      </div>`;
  }

  function renderizarCarrinho() {
    const itens = itensCarrinhoDetalhados();
    if (itens.length === 0) {
      el.carrinhoLista.innerHTML = '<div class="carrinho-vazio">Seu carrinho está vazio. Clique no "+" de um produto pra adicionar.</div>';
    } else {
      el.carrinhoLista.innerHTML = itens.map(carrinhoItemHTML).join('');
    }
    el.carrinhoTotal.textContent = formatarPreco(totalCarrinho(itens));
    el.btnCarrinhoWhatsapp.disabled = itens.length === 0;
    el.btnCarrinhoPdf.disabled = itens.length === 0;
  }

  function abrirCarrinho() {
    renderizarCarrinho();
    el.carrinhoOverlay.hidden = false;
  }

  function fecharCarrinho() {
    el.carrinhoOverlay.hidden = true;
  }

  function montarMensagemWhatsApp(itens, total) {
    const linhas = itens.map((it) => {
      const preco = it.subtotal === null ? 'consulte o preço' : formatarPreco(it.subtotal);
      const sku = it.produto.codigo ? ` (SKU: ${it.produto.codigo})` : '';
      return `• ${it.quantidade}x ${it.produto.produto}${sku} — ${preco}`;
    });
    return (
      '📋 *Pedido feito pelo Catálogo Vesco* (catalogo.vesco.com.br)\n\n' +
      'Olá! Gostaria de fazer um orçamento com os seguintes produtos:\n\n' +
      linhas.join('\n') +
      `\n\nTotal: ${formatarPreco(total)}`
    );
  }

  async function baixarPdfCarrinho() {
    const itens = itensCarrinhoDetalhados();
    if (itens.length === 0) return;
    el.btnCarrinhoPdf.disabled = true;
    const textoOriginal = el.btnCarrinhoPdf.textContent;
    el.btnCarrinhoPdf.textContent = 'Gerando...';
    try {
      const resp = await fetch('/gerar-pdf-carrinho', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itens: itens.map((it) => ({ codigo: it.produto.codigo, quantidade: it.quantidade }))
        })
      });
      if (!resp.ok) throw new Error(await resp.text());
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'orcamento-vesco.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      console.error(err);
      alert('Não foi possível gerar o PDF do carrinho agora. Tente novamente em instantes.');
    } finally {
      el.btnCarrinhoPdf.disabled = itensCarrinhoDetalhados().length === 0;
      el.btnCarrinhoPdf.textContent = textoOriginal;
    }
  }

  let toastTimer = null;
  function mostrarToast(mensagem) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = mensagem;
    toast.classList.remove('toast-saindo');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('toast-saindo');
      setTimeout(() => toast.remove(), 320);
    }, 1600);
  }

  // Um clique só, "delegado" no livro inteiro — os cards são recriados a
  // cada página/filtro, então prender um listener em cada botão "+"
  // individualmente não funcionaria depois da primeira renderização.
  el.livro.addEventListener('click', (e) => {
    const botao = e.target.closest('.produto-add-carrinho');
    if (botao) adicionarAoCarrinho(botao.dataset.codigo);
  });

  el.btnCarrinho.addEventListener('click', abrirCarrinho);
  el.btnFecharCarrinho.addEventListener('click', fecharCarrinho);
  el.carrinhoOverlay.addEventListener('click', (e) => {
    if (e.target === el.carrinhoOverlay) fecharCarrinho();
  });
  el.btnEsvaziarCarrinho.addEventListener('click', () => {
    if (confirm('Esvaziar o carrinho?')) esvaziarCarrinho();
  });
  el.carrinhoLista.addEventListener('click', (e) => {
    const item = e.target.closest('.carrinho-item');
    if (!item) return;
    const codigo = item.dataset.codigo;
    if (e.target.closest('.carrinho-aumentar')) alterarQuantidadeCarrinho(codigo, 1);
    else if (e.target.closest('.carrinho-diminuir')) alterarQuantidadeCarrinho(codigo, -1);
    else if (e.target.closest('.carrinho-item-remover')) removerDoCarrinho(codigo);
  });
  // Confirma o número digitado direto no campo de quantidade quando a
  // pessoa sai do campo (clica em outro lugar) ou aperta Enter — não a
  // cada tecla digitada, pra não "atrapalhar" enquanto ela ainda está
  // digitando (ex.: apagar o "1" pra escrever "12" não pode disparar uma
  // atualização no meio do caminho, com um valor "0" temporário).
  el.carrinhoLista.addEventListener('change', (e) => {
    const campo = e.target.closest('.carrinho-item-input');
    if (!campo) return;
    const item = campo.closest('.carrinho-item');
    if (item) definirQuantidadeCarrinho(item.dataset.codigo, campo.value);
  });
  el.carrinhoLista.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.carrinho-item-input')) {
      e.preventDefault();
      e.target.blur(); // dispara o "change" acima
    }
  });
  el.btnCarrinhoWhatsapp.addEventListener('click', () => {
    const itens = itensCarrinhoDetalhados();
    if (itens.length === 0) return;
    const mensagem = montarMensagemWhatsApp(itens, totalCarrinho(itens));
    window.open(`https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(mensagem)}`, '_blank');
  });
  el.btnCarrinhoPdf.addEventListener('click', baixarPdfCarrinho);

  atualizarContadorCarrinho();

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

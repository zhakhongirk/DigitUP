export type Lang = "en" | "ru";

const RUSSIAN_TAGS = new Set(["ru", "kk"]);

/** Picks the storefront language from an Accept-Language header: Russian (or Kazakh) first wins, otherwise English. */
export function negotiateLang(header: string | null | undefined): Lang {
  if (!header) return "en";
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return {
        primary: tag.trim().toLowerCase().split("-")[0] ?? "",
        weight: Number.isFinite(weight) ? weight : 0,
        index,
      };
    })
    .filter((entry) => entry.primary !== "" && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const top = ranked[0];
  return top && RUSSIAN_TAGS.has(top.primary) ? "ru" : "en";
}

const en = {
  storeNotFound: "Store not found",
  storeNotFoundBody:
    "We could not find what you were looking for. The link may be wrong or the store may be closed.",
  photoSoon: "Photo coming soon",
  priceOnRequest: "Price on request",
  order: "Order",
  book: "Book",
  askShop: "Ask the shop",
  askStore: "Ask the store",
  searchCatalog: "Search the catalog",
  search: "Search",
  categories: "Categories",
  all: "All",
  showing: "Showing {from}–{to} of {total}",
  itemCountOne: "{n} item",
  itemCountMany: "{n} items",
  inCategory: " in {category}",
  matching: ' matching "{query}"',
  nothingFound: "Nothing found. Try a different search or browse all items.",
  showEverything: "Show everything",
  pagination: "Pagination",
  previous: "Previous",
  next: "Next",
  pageOf: "Page {page} of {total}",
  backToCatalog: "Back to catalog",
  cannotOrder: "This item cannot be ordered right now.",
  noPriceYet: "The store has not set a price yet.",
  askConfirm: "Ask the store to confirm details.",
  details: "Details",
  storePolicies: "Store policies",
  contacts: "Contacts",
  home: "{store} home",
  loadingCatalog: "Loading catalog",
  assistantTitle: "{store} Assistant",
  subCatalog: "Answers only from the store's catalog",
  subFallback: "Quick answers from the catalog",
  askInHint: "Ask in English or Russian · Спрашивайте по-русски",
  orderSummary: "Order summary",
  submitted: "Submitted",
  draft: "Draft",
  total: "Total",
  orderSent: "Order sent to the store. The store will confirm it.",
  tryAgain: "Try again",
  send: "Send",
  messageLabel: "Message to the store assistant",
  assistantUnavailable: "Assistant unavailable",
  unavailableNotice:
    "The store assistant is not available yet. You can browse the catalog and contact the store directly.",
  networkError: "Could not reach the store assistant. Check your connection and try again.",
  genericError: "Something went wrong. Please try again.",
  chatWith: "Chat with {store}",
  you: "You: ",
  assistant: "Assistant: ",
  offersFromStore: "Offers from the store",
  storeAssistant: "Store assistant",
  storeSections: "Store sections",
  tabShop: "Shop",
  tabChat: "Chat",
  orderTitle: "Order {number}",
  orderFor: "For {name}",
  orderProgress: "Order progress",
  orderQuestions: "Questions? Ask the store assistant or use the contacts above.",
  lastUpdated: "Last updated",
  items: "Items",
  qtyAt: " × {quantity} at {price}",
  stepSubmitted: "Submitted",
  stepReceived: "Received",
  stepProcessing: "Processing",
  stepCompleted: "Completed",
  stepCancelled: "Cancelled",
  noteSubmitted: "Your order was sent. The store will confirm it soon.",
  noteReceived: "The store has received your order.",
  noteProcessing: "The store is preparing your order.",
  noteCompleted: "Your order is complete.",
  noteCancelled: "This order was cancelled. Contact the store if you have questions.",
  orderStatusTitle: "Order status",
  availInStock: "In stock",
  availOutOfStock: "Out of stock",
  availUnknown: "Availability to be confirmed",
  storeInfo: "Store info",
  searchPlaceholder: "Search brand, model, material",
  policyTbc: "{label}: to be confirmed",
  toBeConfirmed: "To be confirmed",
} as const;

export type StringKey = keyof typeof en;

const ru: Record<StringKey, string> = {
  storeNotFound: "Магазин не найден",
  storeNotFoundBody: "Мы не нашли то, что вы искали. Возможно, ссылка неверна или магазин закрыт.",
  photoSoon: "Фото скоро появится",
  priceOnRequest: "Цена по запросу",
  order: "Заказать",
  book: "Записаться",
  askShop: "Спросить магазин",
  askStore: "Спросить магазин",
  searchCatalog: "Поиск по каталогу",
  search: "Найти",
  categories: "Категории",
  all: "Все",
  showing: "Показано {from}–{to} из {total}",
  itemCountOne: "{n} позиция",
  itemCountMany: "Позиций: {n}",
  inCategory: " в категории {category}",
  matching: ' по запросу "{query}"',
  nothingFound: "Ничего не найдено. Попробуйте другой запрос или посмотрите весь каталог.",
  showEverything: "Показать всё",
  pagination: "Страницы",
  previous: "Назад",
  next: "Далее",
  pageOf: "Страница {page} из {total}",
  backToCatalog: "Назад в каталог",
  cannotOrder: "Эту позицию сейчас нельзя заказать.",
  noPriceYet: "Магазин ещё не указал цену.",
  askConfirm: "Уточните детали у магазина.",
  details: "Характеристики",
  storePolicies: "Правила магазина",
  contacts: "Контакты",
  home: "{store}, главная",
  loadingCatalog: "Загрузка каталога",
  assistantTitle: "Ассистент {store}",
  subCatalog: "Ответы только по каталогу магазина",
  subFallback: "Быстрые ответы по каталогу",
  askInHint: "Спрашивайте по-русски · Ask in English or Russian",
  orderSummary: "Ваш заказ",
  submitted: "Отправлен",
  draft: "Черновик",
  total: "Итого",
  orderSent: "Заказ отправлен в магазин. Магазин подтвердит его.",
  tryAgain: "Повторить",
  send: "Отправить",
  messageLabel: "Сообщение ассистенту магазина",
  assistantUnavailable: "Ассистент недоступен",
  unavailableNotice:
    "Ассистент магазина пока недоступен. Вы можете смотреть каталог и связаться с магазином напрямую.",
  networkError: "Не удалось связаться с ассистентом. Проверьте соединение и повторите.",
  genericError: "Что-то пошло не так. Попробуйте ещё раз.",
  chatWith: "Чат с магазином {store}",
  you: "Вы: ",
  assistant: "Ассистент: ",
  offersFromStore: "Предложения магазина",
  storeAssistant: "Ассистент магазина",
  storeSections: "Разделы магазина",
  tabShop: "Каталог",
  tabChat: "Чат",
  orderTitle: "Заказ {number}",
  orderFor: "Для {name}",
  orderProgress: "Ход выполнения заказа",
  orderQuestions: "Есть вопросы? Спросите ассистента магазина или используйте контакты выше.",
  lastUpdated: "Обновлено",
  items: "Товары",
  qtyAt: " × {quantity} по {price}",
  stepSubmitted: "Отправлен",
  stepReceived: "Получен",
  stepProcessing: "В работе",
  stepCompleted: "Выполнен",
  stepCancelled: "Отменён",
  noteSubmitted: "Заказ отправлен. Магазин скоро его подтвердит.",
  noteReceived: "Магазин получил ваш заказ.",
  noteProcessing: "Магазин готовит ваш заказ.",
  noteCompleted: "Ваш заказ выполнен.",
  noteCancelled: "Заказ отменён. Если есть вопросы, свяжитесь с магазином.",
  orderStatusTitle: "Статус заказа",
  availInStock: "В наличии",
  availOutOfStock: "Нет в наличии",
  availUnknown: "Наличие уточняется",
  storeInfo: "О магазине",
  searchPlaceholder: "Бренд, модель, материал",
  policyTbc: "{label}: уточняется",
  toBeConfirmed: "Уточняется",
};

export const DICTIONARIES: Record<Lang, Record<StringKey, string>> = { en, ru };

export function t(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  const text = DICTIONARIES[lang][key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

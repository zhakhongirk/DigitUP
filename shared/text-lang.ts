export type TextLang = "en" | "ru" | "kk";

const KAZAKH_LETTERS = /[әғқңөұүһі]/i;

const KAZAKH_WORDS =
  /(^|[^а-яёәғқңөұүһі])(тапсырыс\w*|жеткізу\w*|бар\s+ма|жоқ|иә|жарайды|рахмет|рақмет|сатып\s+алам\w*|керек|болады|қанша|өлшем\w*|сәлем\w*|салем|менде|маған|барма|қайда)(?![а-яёәғқңөұүһі])/i;

const CYRILLIC = /[а-яё]/i;

export function detectTextLang(text: string): TextLang {
  if (KAZAKH_LETTERS.test(text)) return "kk";
  if (!CYRILLIC.test(text)) return "en";
  return KAZAKH_WORDS.test(text) ? "kk" : "ru";
}

export const STORE_ANSWER_PREFIX: Record<TextLang, string> = {
  en: "Answer from the store",
  ru: "Ответ магазина",
  kk: "Дүкен жауабы",
};

export const ORDER_CANCELLED_PREFIX: Record<TextLang, string> = {
  en: "Order cancelled by the store",
  ru: "Заказ отменён магазином",
  kk: "Тапсырыстан дүкен бас тартты",
};

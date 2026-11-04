export type ActivityChannel = "storefront" | "external_agent";

export interface ActivityMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ActivityConversation {
  key: string;
  channel: ActivityChannel;
  messages: ActivityMessage[];
}

export interface ActivityOrder {
  channel: ActivityChannel;
  conversation?: string;
  items: { title: string; quantity: number; size?: string }[];
  contact: { name: string; phone: string; email?: string; note: string };
  finalStatus: "submitted" | "received" | "processing" | "completed";
  /** Local "HH:MM" of the most recent past moment the order should look placed at. */
  placedAt?: string;
}

export interface ActivityInquiry {
  subject: string;
  details: string;
  conversation?: string;
  offerTitles: string[];
  contact: { name: string; phone: string; note?: string };
  status: "new" | "in_progress";
}

export interface ActivityPriceChange {
  title: string;
  factor: number;
}

export interface PriceChangeRequest {
  reason: string;
  changes: ActivityPriceChange[];
}

export interface TenantActivity {
  conversations: ActivityConversation[];
  orders: ActivityOrder[];
  inquiries: ActivityInquiry[];
  pendingPriceChanges: PriceChangeRequest;
  rejectedPriceChanges: PriceChangeRequest;
}

export const shoeStoreActivity: TenantActivity = {
  conversations: [
    {
      key: "air-street",
      channel: "storefront",
      messages: [
        { role: "user", text: "Hi! Do you have Nordix Air Street sneakers in size 42?" },
        {
          role: "assistant",
          text: "Yes, the Nordix Air Street Sneakers are available in size 42 and cost 42,000 KZT.",
        },
        { role: "user", text: "Great, I will take one pair. Can you deliver to Astana?" },
        {
          role: "assistant",
          text: "I can place the order for you now, and the store will confirm delivery to Astana by phone.",
        },
      ],
    },
    {
      key: "winter-boots",
      channel: "external_agent",
      messages: [
        { role: "user", text: "I am looking for warm leather boots for winter, size 44." },
        {
          role: "assistant",
          text: "The Altai Winter Leather Boots come in size 44 and are made for cold winters. Would you like the price and colors?",
        },
        { role: "user", text: "Yes please, and tell me which color is in stock." },
        {
          role: "assistant",
          text: "I will check the colors with the store and send you the details.",
        },
      ],
    },
    {
      key: "kids-school",
      channel: "storefront",
      messages: [
        { role: "user", text: "Do you have school sneakers for a 7 year old?" },
        {
          role: "assistant",
          text: "The Tiny Steps School Sneakers are made for kids. What is your child's foot length so I can suggest a size?",
        },
        { role: "user", text: "About 18 cm." },
        {
          role: "assistant",
          text: "That is usually a size 29. I would recommend trying it on in the store or ordering with a size note.",
        },
      ],
    },
    {
      key: "carbon-racer",
      channel: "external_agent",
      messages: [
        { role: "user", text: "How much do the Swiftrun Carbon Racer shoes cost?" },
        {
          role: "assistant",
          text: "The price for the Swiftrun Carbon Racer is given on request. I can send the store a question for you.",
        },
      ],
    },
  ],
  orders: [
    {
      channel: "storefront",
      conversation: "air-street",
      items: [{ title: "Nordix Air Street Sneakers", quantity: 1, size: "42" }],
      contact: {
        name: "Aigerim Sadykova",
        phone: "+7 701 555 12 34",
        email: "aigerim@example.com",
        note: "Size 42. Please call before delivery.",
      },
      finalStatus: "submitted",
    },
    {
      channel: "external_agent",
      conversation: "winter-boots",
      items: [{ title: "Altai Winter Leather Boots", quantity: 1, size: "44" }],
      contact: {
        name: "Daniyar Omarov",
        phone: "+7 705 321 45 67",
        note: "Size 44, black if possible.",
      },
      finalStatus: "processing",
    },
    {
      channel: "storefront",
      conversation: "kids-school",
      items: [{ title: "Tiny Steps School Sneakers", quantity: 1 }],
      contact: {
        name: "Madina Zhaksylykova",
        phone: "+7 707 888 90 12",
        email: "madina@example.com",
        note: "Size 29, pickup from the store.",
      },
      finalStatus: "completed",
    },
    {
      channel: "storefront",
      items: [{ title: "Swiftrun Pulse Running Shoes", quantity: 1, size: "43" }],
      contact: {
        name: "Ruslan Abenov",
        phone: "+7 747 190 22 08",
        note: "Ordered after a late shift, pickup tomorrow.",
      },
      finalStatus: "submitted",
      placedAt: "03:12",
    },
  ],
  inquiries: [
    {
      subject: "Price of Swiftrun Carbon Racer",
      details: "The customer asks for the price and available sizes of the Swiftrun Carbon Racer.",
      conversation: "carbon-racer",
      offerTitles: ["Swiftrun Carbon Racer"],
      contact: { name: "Timur Bekov", phone: "+7 702 410 33 21" },
      status: "new",
    },
    {
      subject: "Corporate order of sandals",
      details:
        "A company wants 20 pairs of Sunway Strap Sandals for staff and asks about a discount.",
      offerTitles: ["Sunway Strap Sandals"],
      contact: {
        name: "Saule Karimova",
        phone: "+7 777 600 18 90",
        note: "Prefers calls after 15:00",
      },
      status: "in_progress",
    },
  ],
  pendingPriceChanges: {
    reason:
      "Lower winter boots before the season ends and raise running shoes after supplier price changes.",
    changes: [
      { title: "Altai Winter Leather Boots", factor: 0.85 },
      { title: "Altai Women's Winter Boots", factor: 0.92 },
      { title: "Swiftrun Pulse Running Shoes", factor: 1.05 },
      { title: "Nordix Air Street Sneakers", factor: 1.04 },
    ],
  },
  rejectedPriceChanges: {
    reason: "Raise prices of loafers by 20% to match the new collection.",
    changes: [
      { title: "Mokko Leather Loafers", factor: 1.2 },
      { title: "Mokko Canvas Slip-ons", factor: 1.2 },
    ],
  },
};

export const barbershopActivity: TenantActivity = {
  conversations: [
    {
      key: "fade-booking",
      channel: "storefront",
      messages: [
        { role: "user", text: "Hello! How much is a skin fade and how long does it take?" },
        {
          role: "assistant",
          text: "A skin fade costs 9,500 KZT and takes about an hour with one of our master barbers.",
        },
        { role: "user", text: "Can I book it for Saturday afternoon?" },
        {
          role: "assistant",
          text: "I can send your booking request with a note about Saturday afternoon, and the shop will confirm the exact time.",
        },
      ],
    },
    {
      key: "father-son",
      channel: "external_agent",
      messages: [
        { role: "user", text: "I want to book a haircut for me and my son, he is 8." },
        {
          role: "assistant",
          text: "The Father and son service covers two haircuts back to back for 11,500 KZT.",
        },
        { role: "user", text: "Sounds good, tomorrow evening if possible." },
        {
          role: "assistant",
          text: "I will pass your request to the shop with your preferred time.",
        },
      ],
    },
    {
      key: "wedding",
      channel: "storefront",
      messages: [
        { role: "user", text: "Do you offer styling for a groom before a wedding?" },
        {
          role: "assistant",
          text: "Yes, the Wedding styling package includes a haircut, beard grooming and styling. The price depends on the package.",
        },
        { role: "user", text: "The wedding is in three weeks. Can someone call me?" },
        {
          role: "assistant",
          text: "Of course. Leave your name and phone number and the shop will call you.",
        },
      ],
    },
    {
      key: "shave",
      channel: "external_agent",
      messages: [
        { role: "user", text: "Is a hot towel shave available on weekdays after 18:00?" },
        {
          role: "assistant",
          text: "The shop works until 21:00 Monday to Saturday, so evening shaves are possible. The Hot towel shave costs 8,000 KZT.",
        },
      ],
    },
  ],
  orders: [
    {
      channel: "storefront",
      conversation: "fade-booking",
      items: [{ title: "Skin fade", quantity: 1 }],
      contact: {
        name: "Alikhan Nurlanov",
        phone: "+7 701 222 33 44",
        note: "Saturday around 15:00, master barber if possible.",
      },
      finalStatus: "submitted",
    },
    {
      channel: "external_agent",
      conversation: "father-son",
      items: [{ title: "Father and son", quantity: 1 }],
      contact: {
        name: "Yerlan Abenov",
        phone: "+7 705 990 11 22",
        email: "yerlan@example.com",
        note: "Tomorrow evening, around 18:30.",
      },
      finalStatus: "received",
    },
    {
      channel: "external_agent",
      conversation: "shave",
      items: [
        { title: "Hot towel shave", quantity: 1 },
        { title: "Beard trim", quantity: 1 },
      ],
      contact: {
        name: "Ruslan Tulegenov",
        phone: "+7 707 123 45 67",
        note: "Weekday after 18:00.",
      },
      finalStatus: "completed",
    },
  ],
  inquiries: [
    {
      subject: "Wedding styling package",
      details:
        "The groom's wedding is in three weeks. He asks for package options and the final price.",
      conversation: "wedding",
      offerTitles: ["Wedding styling"],
      contact: { name: "Nurlan Kasymov", phone: "+7 777 456 78 90" },
      status: "new",
    },
    {
      subject: "Group booking for a team",
      details:
        "Six colleagues want haircuts on the same evening and ask if chairs can be reserved together.",
      offerTitles: ["Classic haircut"],
      contact: { name: "Dana Serik", phone: "+7 702 765 43 21", note: "Writes in Telegram" },
      status: "in_progress",
    },
  ],
  pendingPriceChanges: {
    reason:
      "Raise master-level service prices and add a small increase on classic cuts to cover rising product costs.",
    changes: [
      { title: "Skin fade", factor: 1.15 },
      { title: "Hot towel shave", factor: 1.1 },
      { title: "Hair coloring", factor: 1.08 },
      { title: "Classic haircut", factor: 1.05 },
    ],
  },
  rejectedPriceChanges: {
    reason: "Cut kids haircut and beard trim prices by 20% for a promotion.",
    changes: [
      { title: "Kids haircut", factor: 0.8 },
      { title: "Beard trim", factor: 0.8 },
    ],
  },
};

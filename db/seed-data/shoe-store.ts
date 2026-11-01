import type { BusinessModelInput } from "@/shared/business-model";

type Offer = NonNullable<BusinessModelInput["offers"]>[number];
type Avail = "in_stock" | "out_of_stock" | "unknown";

const ALL_SIZES = Array.from({ length: 12 }, (_, i) => String(35 + i));

function range(from: number, to: number): string[] {
  return ALL_SIZES.filter((s) => Number(s) >= from && Number(s) <= to);
}

/** Product photos for the demo, served from public/demo. */
const PHOTOS: Record<string, string> = {
  "Nordix Air Street Sneakers": "/demo/daily-court.jpg",
  "Velor Retro Court Sneakers": "/demo/suede-skate.jpg",
  "Swiftrun Pulse Running Shoes": "/demo/aero-run-3.jpg",
  "Trailhawk Trail Runners": "/demo/aero-run-3-trail.jpg",
  "Swiftrun Carbon Racer": "/demo/marathon-pro-carbon.jpg",
  "Aeroflex Daily Trainer": "/demo/pacer-lite.jpg",
  "Altai Winter Leather Boots": "/demo/ridge-hiker.jpg",
  "Kazbek Limited Edition Sneakers": "/demo/retro-runner.jpg",
};

interface Row {
  title: string;
  description: string;
  category: string;
  brand: string;
  gender: "men" | "women" | "unisex" | "kids";
  color: string;
  sizes: string[];
  material: string;
  season: "summer" | "winter" | "demi" | "all_season";
  price: number | null;
  availability: Avail;
}

function offer(row: Row): Offer {
  return {
    title: row.title,
    description: row.description,
    category: row.category,
    offer_type: "shoes",
    attributes: {
      brand: row.brand,
      gender: row.gender,
      color: row.color,
      sizes: row.sizes,
      material: row.material,
      season: row.season,
    },
    price: row.price,
    currency: row.price === null ? null : "KZT",
    price_status: row.price === null ? "on_request" : "confirmed",
    availability: row.availability,
    status: "active",
    image_url: PHOTOS[row.title] ?? null,
  };
}

const rows: Row[] = [
  // Sneakers
  {
    title: "Nordix Air Street Sneakers",
    description: "Everyday low-top sneakers with a cushioned insole and a flexible rubber sole.",
    category: "Sneakers",
    brand: "Nordix",
    gender: "unisex",
    color: "White",
    sizes: range(38, 45),
    material: "Leather and mesh",
    season: "all_season",
    price: 42000,
    availability: "in_stock",
  },
  {
    title: "Velor Retro Court Sneakers",
    description: "Retro court silhouette in soft suede with a gum sole.",
    category: "Sneakers",
    brand: "Velor",
    gender: "men",
    color: "Beige",
    sizes: range(40, 46),
    material: "Suede",
    season: "demi",
    price: 48500,
    availability: "in_stock",
  },
  {
    title: "Lumia Platform Sneakers",
    description: "Chunky platform sneakers that add 4 cm of height without the weight.",
    category: "Sneakers",
    brand: "Lumia",
    gender: "women",
    color: "Pink",
    sizes: range(35, 40),
    material: "Synthetic leather",
    season: "demi",
    price: 39000,
    availability: "in_stock",
  },
  {
    title: "Nordix Hightop Classic",
    description: "High-top canvas sneakers with a reinforced toe cap.",
    category: "Sneakers",
    brand: "Nordix",
    gender: "unisex",
    color: "Black",
    sizes: range(36, 45),
    material: "Canvas",
    season: "summer",
    price: 27500,
    availability: "out_of_stock",
  },
  {
    title: "Kazbek Limited Edition Sneakers",
    description:
      "Limited collaboration release with hand-stitched details. Price depends on the batch.",
    category: "Sneakers",
    brand: "Kazbek",
    gender: "unisex",
    color: "Grey",
    sizes: range(39, 44),
    material: "Leather",
    season: "all_season",
    price: null,
    availability: "unknown",
  },
  // Running
  {
    title: "Swiftrun Pulse Running Shoes",
    description: "Lightweight road running shoes with a breathable knit upper and responsive foam.",
    category: "Running",
    brand: "Swiftrun",
    gender: "men",
    color: "Blue",
    sizes: range(40, 46),
    material: "Knit mesh",
    season: "summer",
    price: 58000,
    availability: "in_stock",
  },
  {
    title: "Swiftrun Pulse Women's Running Shoes",
    description: "Women's fit of the Pulse with a narrower heel and extra forefoot cushioning.",
    category: "Running",
    brand: "Swiftrun",
    gender: "women",
    color: "Coral",
    sizes: range(35, 41),
    material: "Knit mesh",
    season: "summer",
    price: 56000,
    availability: "in_stock",
  },
  {
    title: "Trailhawk Trail Runners",
    description: "Aggressive-lug trail runners with a rock plate and water-resistant upper.",
    category: "Running",
    brand: "Trailhawk",
    gender: "unisex",
    color: "Olive",
    sizes: range(38, 46),
    material: "Ripstop textile",
    season: "demi",
    price: 72000,
    availability: "in_stock",
  },
  {
    title: "Swiftrun Carbon Racer",
    description:
      "Racing shoes with a carbon plate. Price and delivery time depend on the current order.",
    category: "Running",
    brand: "Swiftrun",
    gender: "unisex",
    color: "Neon yellow",
    sizes: range(39, 46),
    material: "Engineered mesh",
    season: "summer",
    price: null,
    availability: "unknown",
  },
  {
    title: "Aeroflex Daily Trainer",
    description: "Neutral daily trainer for gym and light jogging, with a wide stable base.",
    category: "Running",
    brand: "Aeroflex",
    gender: "men",
    color: "Black",
    sizes: range(40, 46),
    material: "Mesh",
    season: "all_season",
    price: 35000,
    availability: "out_of_stock",
  },
  // Boots
  {
    title: "Altai Winter Leather Boots",
    description:
      "Insulated leather boots with a wool lining, rated for temperatures down to -30 C.",
    category: "Boots",
    brand: "Altai",
    gender: "men",
    color: "Brown",
    sizes: range(40, 46),
    material: "Full-grain leather",
    season: "winter",
    price: 89000,
    availability: "in_stock",
  },
  {
    title: "Altai Women's Winter Boots",
    description: "Warm ankle boots with a non-slip sole and a side zip for easy fitting.",
    category: "Boots",
    brand: "Altai",
    gender: "women",
    color: "Black",
    sizes: range(35, 41),
    material: "Leather and faux fur",
    season: "winter",
    price: 76000,
    availability: "in_stock",
  },
  {
    title: "Steppe Chelsea Boots",
    description: "Classic Chelsea boots with elastic side panels and a stacked heel.",
    category: "Boots",
    brand: "Steppe",
    gender: "men",
    color: "Dark brown",
    sizes: range(40, 45),
    material: "Leather",
    season: "demi",
    price: 64000,
    availability: "in_stock",
  },
  {
    title: "Steppe Suede Ankle Boots",
    description: "Soft suede ankle boots with a block heel for autumn and spring.",
    category: "Boots",
    brand: "Steppe",
    gender: "women",
    color: "Taupe",
    sizes: range(35, 40),
    material: "Suede",
    season: "demi",
    price: 58500,
    availability: "unknown",
  },
  {
    title: "Altai Expedition Boots",
    description:
      "Heavy-duty waterproof boots built for extreme cold. Made to order, price on request.",
    category: "Boots",
    brand: "Altai",
    gender: "men",
    color: "Black",
    sizes: range(41, 46),
    material: "Waterproof leather",
    season: "winter",
    price: null,
    availability: "unknown",
  },
  // Casual
  {
    title: "Mokko Leather Loafers",
    description: "Slip-on loafers with a cushioned footbed, suitable for the office.",
    category: "Casual",
    brand: "Mokko",
    gender: "men",
    color: "Black",
    sizes: range(40, 46),
    material: "Leather",
    season: "all_season",
    price: 52000,
    availability: "in_stock",
  },
  {
    title: "Mokko Canvas Slip-ons",
    description: "Light canvas slip-ons for warm days. Easy to wash.",
    category: "Casual",
    brand: "Mokko",
    gender: "unisex",
    color: "Navy",
    sizes: range(36, 45),
    material: "Canvas",
    season: "summer",
    price: 15500,
    availability: "in_stock",
  },
  {
    title: "Lumia Ballet Flats",
    description: "Soft leather ballet flats with a padded heel.",
    category: "Casual",
    brand: "Lumia",
    gender: "women",
    color: "Nude",
    sizes: range(35, 41),
    material: "Leather",
    season: "demi",
    price: 33000,
    availability: "in_stock",
  },
  {
    title: "Mokko Handmade Derby Shoes",
    description:
      "Handmade derby shoes with a Goodyear welt. Each pair is made to order, price on request.",
    category: "Casual",
    brand: "Mokko",
    gender: "men",
    color: "Cognac",
    sizes: range(41, 46),
    material: "Calf leather",
    season: "all_season",
    price: null,
    availability: "unknown",
  },
  // Sandals
  {
    title: "Sunway Strap Sandals",
    description: "Adjustable strap sandals with an anatomical cork footbed.",
    category: "Sandals",
    brand: "Sunway",
    gender: "women",
    color: "Tan",
    sizes: range(35, 41),
    material: "Leather and cork",
    season: "summer",
    price: 24500,
    availability: "in_stock",
  },
  {
    title: "Sunway Trek Sandals",
    description: "Sport sandals with a grippy outsole for walking and light hiking.",
    category: "Sandals",
    brand: "Sunway",
    gender: "men",
    color: "Grey",
    sizes: range(40, 46),
    material: "Nylon and rubber",
    season: "summer",
    price: 21000,
    availability: "out_of_stock",
  },
  {
    title: "Lumia Wedge Sandals",
    description:
      "Comfortable wedge sandals with an ankle strap, a good choice for long summer days.",
    category: "Sandals",
    brand: "Lumia",
    gender: "women",
    color: "White",
    sizes: range(35, 40),
    material: "Faux leather",
    season: "summer",
    price: 28000,
    availability: "in_stock",
  },
  // Kids
  {
    title: "Tiny Steps School Sneakers",
    description: "Durable school sneakers with velcro straps and a reflective heel tab.",
    category: "Kids",
    brand: "Tiny Steps",
    gender: "kids",
    color: "Black and red",
    sizes: range(35, 38),
    material: "Textile",
    season: "all_season",
    price: 19500,
    availability: "in_stock",
  },
  {
    title: "Tiny Steps Winter Boots",
    description: "Warm waterproof boots for kids with a removable felt liner.",
    category: "Kids",
    brand: "Tiny Steps",
    gender: "kids",
    color: "Blue",
    sizes: range(35, 38),
    material: "Membrane fabric",
    season: "winter",
    price: 31000,
    availability: "unknown",
  },
  {
    title: "Tiny Steps Summer Sandals",
    description: "Closed-toe sandals for kids with a flexible sole.",
    category: "Kids",
    brand: "Tiny Steps",
    gender: "kids",
    color: "Green",
    sizes: range(35, 37),
    material: "Rubber and textile",
    season: "summer",
    price: 16500,
    availability: "in_stock",
  },
];

export const shoeStoreModel: BusinessModelInput = {
  profile: {
    name: "Stride Shoes",
    description:
      "Stride Shoes is a shoe shop in Almaty with sneakers, running shoes, boots, casual shoes, sandals and kids' footwear for every season.",
    category: "Shoe store",
    contacts: {
      phone: "+7 727 355 01 20",
      whatsapp: "+7 701 355 01 20",
      instagram: "@stride.shoes.almaty",
      address: "Abay Avenue 52, Almaty",
    },
  },
  offer_types: [
    {
      key: "shoes",
      name: "Shoes",
      kind: "product",
      attributes: [
        { key: "brand", label: "Brand", type: "text", required: true },
        {
          key: "gender",
          label: "Gender",
          type: "enum",
          options: ["men", "women", "unisex", "kids"],
          required: true,
        },
        { key: "color", label: "Color", type: "text", required: false },
        { key: "sizes", label: "Sizes", type: "list", options: ALL_SIZES, required: true },
        { key: "material", label: "Material", type: "text", required: false },
        {
          key: "season",
          label: "Season",
          type: "enum",
          options: ["summer", "winter", "demi", "all_season"],
          required: false,
        },
      ],
    },
  ],
  offers: rows.map(offer),
  policies: {
    delivery:
      "Free courier delivery in Almaty for orders over 50,000 KZT, otherwise 1,500 KZT. Delivery to other cities in Kazakhstan takes 3-5 days.",
    payment:
      "Cash, Kaspi QR, Kaspi Red installments and bank cards in the store; Kaspi or card transfer for delivery orders.",
    returns:
      "Unworn shoes with the original box and receipt can be exchanged or returned within 14 days.",
    working_hours: "Every day 10:00-21:00.",
    other: null,
  },
  missing_info: [
    {
      field: "policies.delivery",
      question: "How much does express same-day delivery cost, and is it available outside Almaty?",
      severity: "recommended",
    },
  ],
};

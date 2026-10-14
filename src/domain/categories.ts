/** Default category set. IDs are stable strings so both spouses' devices agree on them. */
export interface DefaultCategory {
  categoryId: string;
  name: string;
  icon: string;
  color: string;
}

export const UNCATEGORIZED_ID = 'cat-uncategorized';

export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  { categoryId: 'cat-groceries', name: 'Groceries', icon: '🛒', color: '#2e7d32' },
  { categoryId: 'cat-restaurants', name: 'Restaurants and dining', icon: '🍽️', color: '#c62828' },
  { categoryId: 'cat-coffee', name: 'Coffee and snacks', icon: '☕', color: '#6d4c41' },
  { categoryId: 'cat-fuel', name: 'Fuel', icon: '⛽', color: '#ef6c00' },
  { categoryId: 'cat-transport', name: 'Transportation and parking', icon: '🚌', color: '#00838f' },
  { categoryId: 'cat-vehicle', name: 'Vehicle maintenance', icon: '🔧', color: '#455a64' },
  { categoryId: 'cat-household', name: 'Household supplies', icon: '🧽', color: '#7cb342' },
  { categoryId: 'cat-housing', name: 'Rent and housing', icon: '🏠', color: '#3949ab' },
  { categoryId: 'cat-utilities', name: 'Utilities', icon: '💡', color: '#f9a825' },
  { categoryId: 'cat-internet', name: 'Internet and phone', icon: '📶', color: '#1e88e5' },
  { categoryId: 'cat-shopping', name: 'Shopping and clothing', icon: '🛍️', color: '#d81b60' },
  { categoryId: 'cat-health', name: 'Health and pharmacy', icon: '💊', color: '#e53935' },
  { categoryId: 'cat-entertainment', name: 'Entertainment', icon: '🎬', color: '#8e24aa' },
  { categoryId: 'cat-travel', name: 'Travel', icon: '✈️', color: '#0277bd' },
  { categoryId: 'cat-personal', name: 'Personal care', icon: '💇', color: '#ad1457' },
  { categoryId: 'cat-pets', name: 'Pets', icon: '🐾', color: '#795548' },
  { categoryId: 'cat-education', name: 'Education', icon: '📚', color: '#5e35b1' },
  { categoryId: 'cat-insurance', name: 'Insurance', icon: '🛡️', color: '#546e7a' },
  { categoryId: 'cat-subscriptions', name: 'Subscriptions', icon: '🔁', color: '#00897b' },
  { categoryId: 'cat-gifts', name: 'Gifts and donations', icon: '🎁', color: '#f4511e' },
  { categoryId: 'cat-fees', name: 'Fees and miscellaneous', icon: '🧾', color: '#757575' },
  { categoryId: UNCATEGORIZED_ID, name: 'Uncategorized', icon: '❔', color: '#9e9e9e' },
];

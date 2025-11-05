const USER_COLORS = [
    '#30bced',
    '#6eeb83',
    '#ffbc42',
    '#ecd444',
    '#ee6352',
    '#9ac2c9',
    '#8acb88',
    '#1be7ff',
]

export function getRandomUserColor() {
    return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]
}

export { USER_COLORS }

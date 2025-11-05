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
    const index = Math.floor(Math.random() * USER_COLORS.length)
    return USER_COLORS[index] ?? '#30bced'
}

export { USER_COLORS }

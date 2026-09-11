import { Catalog } from '@skuio/storefront'
import config from '../../storefront.config'

/**
 * The catalogue, loaded once per build and queried synchronously everywhere.
 *
 * Blocks from the registry import `catalog`, `config` and `routes` from here.
 * Keep these three exports if you restructure.
 */
export { config }
export const routes = config.routes
export const catalog = await Catalog.load(config.provider)

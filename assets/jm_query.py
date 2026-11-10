import json
from datetime import datetime, timezone
from pathlib import Path

import jmcomic


def main():
    job = json.loads(Path('job.json').read_text(encoding='utf-8'))
    constants = jmcomic.JmMagicConstants
    periods = {'day': constants.TIME_TODAY, 'week': constants.TIME_WEEK,
               'month': constants.TIME_MONTH, 'all': constants.TIME_ALL}
    orders = {'latest': constants.ORDER_BY_LATEST, 'views': constants.ORDER_BY_VIEW,
              'likes': constants.ORDER_BY_LIKE, 'comments': constants.ORDER_BY_COMMENT,
              'score': constants.ORDER_BY_SCORE, 'pictures': constants.ORDER_BY_PICTURE}
    option = jmcomic.JmOption.construct({'log': False, 'client': {'impl': 'api', 'retry_times': 1}})
    client = option.build_jm_client()
    action = job['action']
    result = {'source': 'JM', 'fetchedAt': datetime.now(timezone.utc).isoformat(), 'action': action}
    if action == 'detail':
        album = client.get_album_detail(job['albumId'])
        result['album'] = {key: getattr(album, key) for key in
                           ('album_id', 'name', 'description', 'page_count', 'pub_date',
                            'update_date', 'likes', 'views', 'comment_count', 'works',
                            'actors', 'authors', 'tags', 'episode_list')}
        result['album']['description'] = str(album.description)[:4000]
        for key in ('works', 'actors', 'authors', 'tags', 'episode_list'):
            result['album'][key] = result['album'][key][:100]
    else:
        page = int(job.get('page', 1))
        period = job.get('period', 'all')
        order = job.get('order') or ('views' if action == 'ranking' else 'latest')
        if action == 'ranking':
            data = client.categories_filter(page, periods[period], constants.CATEGORY_ALL, orders[order])
        elif action == 'search':
            search_by = job.get('searchBy', 'site')
            methods = {'site': client.search_site, 'work': client.search_work,
                       'author': client.search_author, 'tag': client.search_tag,
                       'actor': client.search_actor}
            data = methods[search_by](job['query'], page=page, order_by=orders[order], time=periods[period])
            result.update({'query': job['query'], 'searchBy': search_by})
        else:
            raise ValueError('不支持的查询类型')
        result.update({'page': page, 'total': data.total, 'pageCount': data.page_count,
                       'period': period, 'order': order,
                       'items': [{'albumId': str(album_id), 'name': str(info.get('name', ''))[:100],
                                  'tags': [str(tag)[:50] for tag in (info.get('tags') or [])[:8]]}
                                 for album_id, info in data.content]})
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()

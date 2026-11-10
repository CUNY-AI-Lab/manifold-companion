import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorNote, Spinner } from '../components/ui';
import ImageTextPage from './ImageTextPage';
import HtmlTextPage from './HtmlTextPage';

export default function TextRoute() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => api.get(`/api/texts/${id}`).then(setData, setError), [id]);
  useEffect(() => { setData(null); reload(); }, [reload]);
  if (error && !data) return <ErrorNote error={error.status === 404 ? { message: 'This text does not exist or you no longer have access to it.' } : error} />;
  if (!data) return <Spinner />;
  return data.project_type === 'pdf_to_html' ? <HtmlTextPage data={data} reload={reload} /> : <ImageTextPage data={data} reload={reload} />;
}

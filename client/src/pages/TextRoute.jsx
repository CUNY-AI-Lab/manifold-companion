import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import TextDetail from './TextDetail';
import HtmlTextDetail from './HtmlTextDetail';

export default function TextRoute() {
  const { id } = useParams();
  const [projectType, setProjectType] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    api.get(`/api/texts/${id}`)
      .then((data) => {
        if (active) setProjectType(data.project_type || 'image_to_markdown');
      })
      .catch((err) => {
        if (active) setError(err.message);
      });

    return () => {
      active = false;
    };
  }, [id]);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
      </div>
    );
  }

  if (!projectType) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
      </div>
    );
  }

  return projectType === 'pdf_to_html' ? <HtmlTextDetail /> : <TextDetail />;
}

import type {Metadata} from 'next';
import {SafetyRegistration} from '@/components/SafetyRegistration';

export const metadata: Metadata = {
  title: 'Регистрация похода в МЧС',
  description: 'Подготовьте паспорт безопасности, состав группы и данные маршрута для переноса в официальную форму МЧС России.',
};

export default function SafetyRegistrationPage() {
  return <SafetyRegistration/>;
}
